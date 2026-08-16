import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactSensitiveText } from '../safety.js';
import {
  type Clause,
  type Literal,
  ParseError,
  canonicalKey,
  isComparison,
  isNegation,
  literalMatches,
  parseProgram,
  parseQuery,
  serializeClause,
} from '../engine/index.js';

const NAMESPACE_RE = /^[a-z0-9_-]+$/;
const HEADER = '% rembero memory — one Datalog clause per line; edit by hand if you like.\n';
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_ERROR_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const MAX_REVIEW_DAYS = 3_650;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export interface AssertResult {
  added: Clause[];
  duplicates: number;
  opId: string;
}

export interface MutationContext {
  opId?: string;
  sourceText?: string;
  origin?: 'manual' | 'claude-stop';
  captureId?: string;
  at?: Date;
}

export interface MemorySource {
  namespace: string;
  opId: string;
  ts: string;
  text?: string;
  redacted?: boolean;
}

export type AutoCaptureStatus = 'started' | 'captured' | 'empty' | 'failed' | 'skipped';

export interface AutoCaptureReservationRequest {
  captureId?: string;
  fingerprint: string;
  sessionId: string;
  tailBytes: number;
  dailyCap: number;
  at?: Date;
}

export interface AutoCaptureReservation {
  captureId: string;
  reserved: boolean;
  reason?: 'duplicate' | 'daily_cap';
}

export interface AutoCaptureBatch {
  captureId: string;
  namespace: string;
  ts: string;
  status: AutoCaptureStatus;
  sessionId?: string;
  reason?: string;
  added?: number;
  duplicates?: number;
}

export interface AutoCaptureFact {
  id: string;
  captureId: string;
  opId: string;
  namespace: string;
  ts: string;
  clause: string;
  current: boolean;
}

export interface AutoCaptureReview {
  captures: AutoCaptureBatch[];
  facts: AutoCaptureFact[];
}

export interface AutoCaptureReviewOptions {
  days?: number;
  namespace?: string;
  now?: Date;
}

export interface PruneAutoCaptureOptions {
  now?: Date;
}

interface CachedNamespace {
  clauses: Clause[];
  keys: Set<string>;
  /** mtime+size of the file this cache was read from; '' when the file did not exist. */
  fileStamp: string;
}

interface JournalEntry {
  ts: string;
  op: string;
  namespace: string;
  [key: string]: unknown;
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

function sanitizeJournalDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...details };
  let redacted = false;
  for (const key of ['text', 'sourceText']) {
    const value = sanitized[key];
    if (typeof value === 'string') {
      const result = redactSensitiveText(value);
      sanitized[key] = result.text;
      redacted ||= result.redacted;
    }
  }
  return redacted ? { ...sanitized, sourceRedacted: true } : sanitized;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value;
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function autoCaptureFactId(captureId: string, namespace: string, clause: string): string {
  const digest = createHash('sha256')
    .update(`${captureId}\0${namespace}\0${clause}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${captureId}:${digest}`;
}

export function defaultRoot(): string {
  return join(process.env.REMBERO_HOME ?? join(homedir(), '.rembero'), 'memory');
}

export class MemoryStore {
  private cache = new Map<string, CachedNamespace>();

  constructor(private root: string = defaultRoot()) {}

  createOperationId(): string {
    return randomUUID();
  }

  private withLock<T>(name: string, operation: () => T): T {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, `.${name}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let descriptor: number | undefined;
    let ownedDevice: number | undefined;
    let ownedInode: number | undefined;
    while (descriptor === undefined) {
      try {
        const acquired = openSync(lockPath, 'wx', 0o600);
        try {
          writeFileSync(
            acquired,
            `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
            'utf8'
          );
          const owned = fstatSync(acquired);
          ownedDevice = owned.dev;
          ownedInode = owned.ino;
          descriptor = acquired;
        } catch (error) {
          closeSync(acquired);
          try {
            unlinkSync(lockPath);
          } catch {
            // Preserve the acquisition failure.
          }
          throw error;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        try {
          const lock = lstatSync(lockPath);
          if (lock.isSymbolicLink()) {
            throw new Error(`refusing symbolic-link lock file ${lockPath}`);
          }
          let ownerAlive = false;
          try {
            const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
            if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) {
              try {
                process.kill(owner.pid as number, 0);
                ownerAlive = true;
              } catch (ownerError) {
                ownerAlive = (ownerError as NodeJS.ErrnoException).code === 'EPERM';
              }
            }
          } catch {
            // A crashed writer can leave an empty or partial lock; age still gates cleanup.
          }
          if (Date.now() - lock.mtimeMs > LOCK_STALE_MS && !ownerAlive) {
            unlinkSync(lockPath);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for memory lock '${name}'`);
        }
        Atomics.wait(sleepCell, 0, 0, LOCK_RETRY_MS);
      }
    }
    try {
      return operation();
    } finally {
      closeSync(descriptor);
      try {
        const current = lstatSync(lockPath);
        if (current.dev === ownedDevice && current.ino === ownedInode) {
          unlinkSync(lockPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private withNamespaceLock<T>(namespace: string, operation: () => T): T {
    this.filePath(namespace);
    return this.withLock(`namespace-${namespace}`, operation);
  }

  private journalPath(): string {
    return join(this.root, 'journal.log');
  }

  private captureErrorPath(): string {
    return join(this.root, 'capture-errors.log');
  }

  private createJournalEntry(
    namespace: string,
    op: string,
    details: Record<string, unknown>,
    at: Date
  ): JournalEntry {
    this.filePath(namespace);
    return {
      ts: validDate(at, 'journal timestamp').toISOString(),
      op,
      namespace,
      ...sanitizeJournalDetails(details),
    };
  }

  private appendJournalUnlocked(entry: JournalEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    const path = this.journalPath();
    const currentBytes = existsSync(path) ? statSync(path).size : 0;
    const nextBytes = currentBytes + Buffer.byteLength(line, 'utf8');
    if (nextBytes > MAX_JOURNAL_BYTES) {
      throw new Error(`journal.log would exceed ${MAX_JOURNAL_BYTES} bytes`);
    }
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  }

  private readJournalUnlocked(): JournalEntry[] {
    const path = this.journalPath();
    let text: string;
    try {
      const stat = statSync(path);
      if (stat.size > MAX_JOURNAL_BYTES) {
        throw new Error(`journal.log exceeds ${MAX_JOURNAL_BYTES} bytes`);
      }
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: JournalEntry[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trim() === '') continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`failed to read journal.log line ${index + 1}`);
      }
      if (
        typeof entry !== 'object' ||
        entry === null ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).ts !== 'string' ||
        typeof (entry as Record<string, unknown>).op !== 'string' ||
        typeof (entry as Record<string, unknown>).namespace !== 'string'
      ) {
        throw new Error(`failed to read journal.log line ${index + 1}`);
      }
      entries.push(entry as JournalEntry);
    }
    return entries;
  }

  private readCaptureErrorsUnlocked(): JournalEntry[] {
    const path = this.captureErrorPath();
    let text: string;
    try {
      const stat = statSync(path);
      if (stat.size > MAX_CAPTURE_ERROR_BYTES) {
        throw new Error(`capture-errors.log exceeds ${MAX_CAPTURE_ERROR_BYTES} bytes`);
      }
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: JournalEntry[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trim() === '') continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`failed to read capture-errors.log line ${index + 1}`);
      }
      if (
        typeof entry !== 'object' ||
        entry === null ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).ts !== 'string' ||
        (entry as Record<string, unknown>).op !== 'auto_capture' ||
        typeof (entry as Record<string, unknown>).namespace !== 'string'
      ) {
        throw new Error(`failed to read capture-errors.log line ${index + 1}`);
      }
      entries.push(entry as JournalEntry);
    }
    return entries;
  }

  private filePath(namespace: string): string {
    if (!NAMESPACE_RE.test(namespace)) {
      throw new Error(
        `invalid namespace '${namespace}': use lowercase letters, digits, '_' or '-'`
      );
    }
    return join(this.root, `${namespace}.dl`);
  }

  private loadCached(namespace: string): CachedNamespace {
    const path = this.filePath(namespace);
    const stamp = fileStamp(path);
    const cached = this.cache.get(namespace);
    // another process may have written the file since we cached it
    if (cached && cached.fileStamp === stamp) return cached;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      const empty = { clauses: [], keys: new Set<string>(), fileStamp: stamp };
      this.cache.set(namespace, empty);
      return empty;
    }
    let clauses: Clause[];
    try {
      clauses = parseProgram(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new ParseError(`failed to load ${path}: ${message}`);
    }
    const entry = { clauses, keys: new Set(clauses.map(canonicalKey)), fileStamp: stamp };
    this.cache.set(namespace, entry);
    return entry;
  }

  private save(namespace: string, entry: CachedNamespace): void {
    mkdirSync(this.root, { recursive: true });
    const facts = entry.clauses.filter((c) => c.body.length === 0);
    const rules = entry.clauses.filter((c) => c.body.length > 0);
    const body = [...facts, ...rules].map(serializeClause).join('\n');
    const path = this.filePath(namespace);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${HEADER}${body}\n`, 'utf8');
    renameSync(tmp, path);
    entry.fileStamp = fileStamp(path);
  }

  load(namespace: string): Clause[] {
    return this.loadCached(namespace).clauses;
  }

  /** Append an entry to the append-only operation journal ("why does it think that?"). */
  note(
    namespace: string,
    op: string,
    details: Record<string, unknown> = {},
    at = new Date()
  ): void {
    const entry = this.createJournalEntry(namespace, op, details, at);
    this.withLock('journal', () => this.appendJournalUnlocked(entry));
  }

  assert(
    namespace: string,
    clauses: string | Clause[],
    context: MutationContext = {}
  ): AssertResult {
    const opId = context.opId ?? this.createOperationId();
    const parsed = typeof clauses === 'string' ? parseProgram(clauses) : clauses;
    return this.withNamespaceLock(namespace, () => {
      const loaded = this.loadCached(namespace);
      const entry: CachedNamespace = {
        clauses: [...loaded.clauses],
        keys: new Set(loaded.keys),
        fileStamp: loaded.fileStamp,
      };
      const added: Clause[] = [];
      let duplicates = 0;
      for (const clause of parsed) {
        const key = canonicalKey(clause);
        if (entry.keys.has(key)) {
          duplicates++;
        } else {
          entry.keys.add(key);
          entry.clauses.push(clause);
          added.push(clause);
        }
      }
      if (added.length > 0) {
        const journalEntry = this.createJournalEntry(
          namespace,
          'assert',
          {
            opId,
            added: added.map(serializeClause),
            duplicates,
            ...(context.sourceText === undefined ? {} : { sourceText: context.sourceText }),
            ...(context.origin === undefined ? {} : { origin: context.origin }),
            ...(context.captureId === undefined ? {} : { captureId: context.captureId }),
          },
          context.at ?? new Date()
        );
        this.withLock('journal', () => {
          const lineBytes = Buffer.byteLength(`${JSON.stringify(journalEntry)}\n`, 'utf8');
          const path = this.journalPath();
          const currentBytes = existsSync(path) ? statSync(path).size : 0;
          if (currentBytes + lineBytes > MAX_JOURNAL_BYTES) {
            throw new Error(`journal.log would exceed ${MAX_JOURNAL_BYTES} bytes`);
          }
          this.save(namespace, entry);
          this.appendJournalUnlocked(journalEntry);
          this.cache.set(namespace, entry);
        });
      }
      return { added, duplicates, opId };
    });
  }

  retract(
    namespace: string,
    pattern: string,
    context: MutationContext = {}
  ): { removed: number; opId: string } {
    const opId = context.opId ?? this.createOperationId();
    return this.withNamespaceLock(namespace, () => {
      const loaded = this.loadCached(namespace);
      const entry: CachedNamespace = {
        clauses: [...loaded.clauses],
        keys: new Set(loaded.keys),
        fileStamp: loaded.fileStamp,
      };
      let keep: Clause[];
      if (pattern.includes(':-')) {
        // exact rule removal by alpha-equivalence
        const [rule] = parseProgram(pattern);
        const key = canonicalKey(rule);
        keep = entry.clauses.filter((c) => canonicalKey(c) !== key);
      } else {
        const goals = parseQuery(pattern);
        if (goals.length !== 1 || isComparison(goals[0]) || isNegation(goals[0])) {
          throw new ParseError('forget pattern must be a single literal, e.g. works_at(rahul, _)');
        }
        const literal = goals[0] as Literal;
        keep = entry.clauses.filter(
          (c) => c.body.length > 0 || !literalMatches(literal, c.head)
        );
      }
      const removed = entry.clauses.length - keep.length;
      if (removed > 0) {
        const journalEntry = this.createJournalEntry(
          namespace,
          'retract',
          {
            opId,
            pattern,
            removed,
            ...(context.sourceText === undefined ? {} : { sourceText: context.sourceText }),
            ...(context.origin === undefined ? {} : { origin: context.origin }),
            ...(context.captureId === undefined ? {} : { captureId: context.captureId }),
          },
          context.at ?? new Date()
        );
        this.withLock('journal', () => {
          const lineBytes = Buffer.byteLength(`${JSON.stringify(journalEntry)}\n`, 'utf8');
          const path = this.journalPath();
          const currentBytes = existsSync(path) ? statSync(path).size : 0;
          if (currentBytes + lineBytes > MAX_JOURNAL_BYTES) {
            throw new Error(`journal.log would exceed ${MAX_JOURNAL_BYTES} bytes`);
          }
          entry.clauses = keep;
          entry.keys = new Set(keep.map(canonicalKey));
          this.save(namespace, entry);
          this.appendJournalUnlocked(journalEntry);
          this.cache.set(namespace, entry);
        });
      }
      return { removed, opId };
    });
  }

  private retractFactIfSourcedBy(
    namespace: string,
    serialized: string,
    expectedSourceOpId: string,
    context: Required<Pick<MutationContext, 'opId' | 'captureId' | 'at'>>
  ): number {
    const clauses = parseProgram(serialized);
    if (clauses.length !== 1 || clauses[0].body.length !== 0) {
      throw new Error('auto-capture pruning accepts exactly one ground fact');
    }
    const target = clauses[0];
    const targetKey = canonicalKey(target);
    return this.withNamespaceLock(namespace, () => {
      const loaded = this.loadCached(namespace);
      if (!loaded.keys.has(targetKey)) return 0;
      const entry: CachedNamespace = {
        clauses: [...loaded.clauses],
        keys: new Set(loaded.keys),
        fileStamp: loaded.fileStamp,
      };

      return this.withLock('journal', () => {
        let latestSourceOpId: string | undefined;
        for (const journalEntry of this.readJournalUnlocked()) {
          if (
            journalEntry.op !== 'assert' ||
            journalEntry.namespace !== namespace ||
            typeof journalEntry.opId !== 'string' ||
            !Array.isArray(journalEntry.added)
          ) {
            continue;
          }
          const containsTarget = journalEntry.added.some((candidate) => {
            if (typeof candidate !== 'string') return false;
            const [clause] = parseProgram(candidate);
            return canonicalKey(clause) === targetKey;
          });
          if (containsTarget) latestSourceOpId = journalEntry.opId;
        }
        if (latestSourceOpId !== expectedSourceOpId) return 0;

        entry.clauses = entry.clauses.filter((clause) => canonicalKey(clause) !== targetKey);
        entry.keys.delete(targetKey);
        const journalEntry = this.createJournalEntry(
          namespace,
          'retract',
          {
            opId: context.opId,
            pattern: serializeClause(target),
            removed: 1,
            sourceText: 'Pruned from auto-capture review',
            origin: 'manual',
            captureId: context.captureId,
          },
          context.at
        );
        const lineBytes = Buffer.byteLength(`${JSON.stringify(journalEntry)}\n`, 'utf8');
        const path = this.journalPath();
        const currentBytes = existsSync(path) ? statSync(path).size : 0;
        if (currentBytes + lineBytes > MAX_JOURNAL_BYTES) {
          throw new Error(`journal.log would exceed ${MAX_JOURNAL_BYTES} bytes`);
        }
        this.save(namespace, entry);
        this.appendJournalUnlocked(journalEntry);
        this.cache.set(namespace, entry);
        return 1;
      });
    });
  }

  reserveAutoCapture(
    namespace: string,
    request: AutoCaptureReservationRequest
  ): AutoCaptureReservation {
    this.filePath(namespace);
    if (!/^[a-f0-9]{64}$/.test(request.fingerprint)) {
      throw new Error('auto-capture fingerprint must be a SHA-256 hex digest');
    }
    if (!/^[a-zA-Z0-9._-]{1,256}$/.test(request.sessionId)) {
      throw new Error('auto-capture session id contains invalid characters');
    }
    if (!Number.isSafeInteger(request.tailBytes) || request.tailBytes < 0) {
      throw new Error('auto-capture tail byte count must be a non-negative integer');
    }
    if (!Number.isSafeInteger(request.dailyCap) || request.dailyCap < 1) {
      throw new Error('auto-capture daily cap must be a positive integer');
    }
    const at = validDate(request.at ?? new Date(), 'auto-capture timestamp');
    const captureId = request.captureId ?? this.createOperationId();
    if (!/^[a-zA-Z0-9._-]{1,256}$/.test(captureId)) {
      throw new Error('auto-capture id contains invalid characters');
    }

    return this.withLock('journal', () => {
      const entries = this.readJournalUnlocked();
      const duplicate = entries.some(
        (entry) =>
          entry.op === 'auto_capture' &&
          entry.namespace === namespace &&
          entry.status === 'started' &&
          entry.fingerprint === request.fingerprint
      );
      if (duplicate) {
        this.appendJournalUnlocked(
          this.createJournalEntry(
            namespace,
            'auto_capture',
            {
              captureId,
              status: 'skipped',
              reason: 'duplicate',
              source: 'claude-stop',
              sessionId: request.sessionId,
              fingerprint: request.fingerprint,
              tailBytes: request.tailBytes,
            },
            at
          )
        );
        return { captureId, reserved: false, reason: 'duplicate' };
      }

      const day = utcDay(at);
      const used = entries.filter(
        (entry) =>
          entry.op === 'auto_capture' &&
          entry.namespace === namespace &&
          entry.status === 'started' &&
          typeof entry.ts === 'string' &&
          entry.ts.slice(0, 10) === day
      ).length;
      if (used >= request.dailyCap) {
        this.appendJournalUnlocked(
          this.createJournalEntry(
            namespace,
            'auto_capture',
            {
              captureId,
              status: 'skipped',
              reason: 'daily_cap',
              source: 'claude-stop',
              sessionId: request.sessionId,
              fingerprint: request.fingerprint,
              tailBytes: request.tailBytes,
              dailyCap: request.dailyCap,
            },
            at
          )
        );
        return { captureId, reserved: false, reason: 'daily_cap' };
      }

      this.appendJournalUnlocked(
        this.createJournalEntry(
          namespace,
          'auto_capture',
          {
            captureId,
            status: 'started',
            source: 'claude-stop',
            sessionId: request.sessionId,
            fingerprint: request.fingerprint,
            tailBytes: request.tailBytes,
            dailyCap: request.dailyCap,
          },
          at
        )
      );
      return { captureId, reserved: true };
    });
  }

  finishAutoCapture(
    namespace: string,
    captureId: string,
    status: Exclude<AutoCaptureStatus, 'started' | 'skipped'>,
    details: { added?: number; duplicates?: number; reason?: string } = {},
    at = new Date()
  ): void {
    if (captureId.trim() === '' || captureId.length > 256) {
      throw new Error('auto-capture id must be between 1 and 256 characters');
    }
    if (details.reason !== undefined && !/^[a-z0-9_-]{1,64}$/.test(details.reason)) {
      throw new Error('auto-capture failure reason must be a short machine-readable code');
    }
    this.note(
      namespace,
      'auto_capture',
      {
        captureId,
        status,
        source: 'claude-stop',
        ...(details.added === undefined ? {} : { added: details.added }),
        ...(details.duplicates === undefined ? {} : { duplicates: details.duplicates }),
        ...(details.reason === undefined ? {} : { reason: details.reason }),
      },
      at
    );
  }

  recordAutoCaptureSkip(
    namespace: string,
    reason: string,
    options: { captureId?: string; at?: Date } = {}
  ): string {
    if (!/^[a-z0-9_-]{1,64}$/.test(reason)) {
      throw new Error('auto-capture skip reason must be a short machine-readable code');
    }
    const captureId = options.captureId ?? this.createOperationId();
    this.note(
      namespace,
      'auto_capture',
      { captureId, status: 'skipped', reason, source: 'claude-stop' },
      options.at
    );
    return captureId;
  }

  /**
   * Record a capture failure when the primary journal itself is unavailable.
   * This secondary bounded log uses an independent lock and is merged into review.
   */
  recordAutoCaptureEmergency(
    namespace: string,
    captureId: string,
    reason = 'journal_unavailable',
    at = new Date()
  ): void {
    if (!/^[a-zA-Z0-9._-]{1,256}$/.test(captureId)) {
      throw new Error('auto-capture id contains invalid characters');
    }
    if (!/^[a-z0-9_-]{1,64}$/.test(reason)) {
      throw new Error('auto-capture emergency reason must be a short machine-readable code');
    }
    const entry = this.createJournalEntry(
      namespace,
      'auto_capture',
      {
        captureId,
        status: 'failed',
        reason,
        source: 'claude-stop',
        fallback: true,
      },
      at
    );
    this.withLock('capture-errors', () => {
      const path = this.captureErrorPath();
      const line = `${JSON.stringify(entry)}\n`;
      const currentBytes = existsSync(path) ? statSync(path).size : 0;
      if (currentBytes + Buffer.byteLength(line, 'utf8') > MAX_CAPTURE_ERROR_BYTES) {
        throw new Error(`capture-errors.log would exceed ${MAX_CAPTURE_ERROR_BYTES} bytes`);
      }
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
    });
  }

  reviewAutoCaptures(options: AutoCaptureReviewOptions = {}): AutoCaptureReview {
    const days = options.days ?? 7;
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_REVIEW_DAYS) {
      throw new Error(`review days must be an integer between 1 and ${MAX_REVIEW_DAYS}`);
    }
    if (options.namespace !== undefined) this.filePath(options.namespace);
    const now = validDate(options.now ?? new Date(), 'review timestamp');
    const since = now.getTime() - days * 24 * 60 * 60 * 1000;
    const entries = [
      ...this.withLock('journal', () => this.readJournalUnlocked()),
      ...this.withLock('capture-errors', () => this.readCaptureErrorsUnlocked()),
    ].sort((left, right) => left.ts.localeCompare(right.ts));
    const captures = new Map<string, AutoCaptureBatch>();
    const facts: AutoCaptureFact[] = [];

    for (const entry of entries) {
      if (options.namespace !== undefined && entry.namespace !== options.namespace) continue;
      const timestamp = Date.parse(entry.ts);
      if (!Number.isFinite(timestamp) || timestamp < since || timestamp > now.getTime()) continue;
      if (
        entry.op === 'auto_capture' &&
        typeof entry.captureId === 'string' &&
        (entry.status === 'started' ||
          entry.status === 'captured' ||
          entry.status === 'empty' ||
          entry.status === 'failed' ||
          entry.status === 'skipped')
      ) {
        const previous = captures.get(entry.captureId);
        captures.set(entry.captureId, {
          captureId: entry.captureId,
          namespace: entry.namespace,
          ts: previous?.ts ?? entry.ts,
          status: entry.status,
          ...(typeof entry.sessionId === 'string'
            ? { sessionId: entry.sessionId }
            : previous?.sessionId === undefined
              ? {}
              : { sessionId: previous.sessionId }),
          ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
          ...(typeof entry.added === 'number' ? { added: entry.added } : {}),
          ...(typeof entry.duplicates === 'number' ? { duplicates: entry.duplicates } : {}),
        });
      }
    }

    const sourceOperationsByNamespace = new Map<string, Map<string, string>>();
    const sourceOperations = (namespace: string): Map<string, string> => {
      const existing = sourceOperationsByNamespace.get(namespace);
      if (existing !== undefined) return existing;
      const operations = new Map<string, string>();
      for (const [key, sources] of this.sourcesFor([namespace])) {
        const source = sources.find((candidate) => candidate.namespace === namespace);
        if (source !== undefined) operations.set(key, source.opId);
      }
      sourceOperationsByNamespace.set(namespace, operations);
      return operations;
    };

    for (const entry of entries) {
      if (options.namespace !== undefined && entry.namespace !== options.namespace) continue;
      const timestamp = Date.parse(entry.ts);
      if (!Number.isFinite(timestamp) || timestamp < since || timestamp > now.getTime()) continue;
      if (
        entry.op !== 'assert' ||
        entry.origin !== 'claude-stop' ||
        typeof entry.captureId !== 'string' ||
        typeof entry.opId !== 'string' ||
        !Array.isArray(entry.added)
      ) {
        continue;
      }
      for (const serialized of entry.added) {
        if (typeof serialized !== 'string') continue;
        const [clause] = parseProgram(serialized);
        const canonical = serializeClause(clause);
        facts.push({
          id: autoCaptureFactId(entry.captureId, entry.namespace, canonical),
          captureId: entry.captureId,
          opId: entry.opId,
          namespace: entry.namespace,
          ts: entry.ts,
          clause: canonical,
          current: sourceOperations(entry.namespace).get(canonicalKey(clause)) === entry.opId,
        });
      }
    }

    const sortedCaptures = [...captures.values()].sort(
      (left, right) =>
        right.ts.localeCompare(left.ts) || left.captureId.localeCompare(right.captureId)
    );
    facts.sort(
      (left, right) =>
        right.ts.localeCompare(left.ts) ||
        left.namespace.localeCompare(right.namespace) ||
        left.clause.localeCompare(right.clause) ||
        left.id.localeCompare(right.id)
    );
    return { captures: sortedCaptures, facts };
  }

  pruneAutoCaptureFacts(
    selections: AutoCaptureFact[],
    options: PruneAutoCaptureOptions = {}
  ): { removed: number; opId: string } {
    const at = validDate(options.now ?? new Date(), 'prune timestamp');
    const opId = this.createOperationId();
    if (selections.length === 0) return { removed: 0, opId };

    const entries = this.withLock('journal', () => this.readJournalUnlocked());
    const allowed = new Map<string, AutoCaptureFact>();
    for (const entry of entries) {
      if (
        entry.op !== 'assert' ||
        entry.origin !== 'claude-stop' ||
        typeof entry.captureId !== 'string' ||
        typeof entry.opId !== 'string' ||
        !Array.isArray(entry.added)
      ) {
        continue;
      }
      for (const serialized of entry.added) {
        if (typeof serialized !== 'string') continue;
        const [clause] = parseProgram(serialized);
        const canonical = serializeClause(clause);
        const id = autoCaptureFactId(entry.captureId, entry.namespace, canonical);
        allowed.set(`${id}\0${entry.opId}`, {
          id,
          captureId: entry.captureId,
          opId: entry.opId,
          namespace: entry.namespace,
          ts: entry.ts,
          clause: canonical,
          current: false,
        });
      }
    }

    const unique = new Map<string, AutoCaptureFact>();
    for (const selection of selections) {
      const key = `${selection.id}\0${selection.opId}`;
      const journalFact = allowed.get(key);
      if (
        journalFact === undefined ||
        journalFact.captureId !== selection.captureId ||
        journalFact.namespace !== selection.namespace ||
        journalFact.clause !== selection.clause
      ) {
        throw new Error(`auto-capture fact '${selection.id}' is not present in the journal`);
      }
      unique.set(key, journalFact);
    }

    let removed = 0;
    const byNamespace = new Map<string, AutoCaptureFact[]>();
    for (const selection of unique.values()) {
      const group = byNamespace.get(selection.namespace) ?? [];
      group.push(selection);
      byNamespace.set(selection.namespace, group);
    }
    for (const [namespace, selected] of byNamespace) {
      let namespaceRemoved = 0;
      for (const selection of selected) {
        namespaceRemoved += this.retractFactIfSourcedBy(
          namespace,
          selection.clause,
          selection.opId,
          { opId, captureId: selection.captureId, at }
        );
      }
      removed += namespaceRemoved;
      this.note(
        namespace,
        'auto_capture_pruned',
        {
          opId,
          removed: namespaceRemoved,
          factIds: selected.map((selection) => selection.id).sort(),
          captureIds: [...new Set(selected.map((selection) => selection.captureId))].sort(),
        },
        at
      );
    }
    return { removed, opId };
  }

  listNamespaces(): string[] {
    let files: string[];
    try {
      files = readdirSync(this.root);
    } catch {
      return [];
    }
    return files
      .filter((f) => f.endsWith('.dl'))
      .map((f) => f.slice(0, -3))
      .sort();
  }

  clausesFor(namespaces: string[] | '*'): Clause[] {
    const names = namespaces === '*' ? this.listNamespaces() : namespaces;
    return names.flatMap((ns) => this.load(ns));
  }

  /** Latest durable assertion source for every currently stored clause. */
  sourcesFor(namespaces: string[] | '*'): Map<string, MemorySource[]> {
    const names = namespaces === '*' ? this.listNamespaces() : [...namespaces];
    const namespaceOrder = new Map(names.map((name, index) => [name, index]));
    const selected = new Set(names);
    const current = new Set<string>();
    for (const namespace of names) {
      for (const clause of this.load(namespace)) {
        current.add(`${namespace}\u0000${canonicalKey(clause)}`);
      }
    }

    const entries = this.withLock('journal', () => this.readJournalUnlocked());
    const latest = new Map<string, { key: string; source: MemorySource }>();
    for (const entry of entries) {
      if (
        entry.op !== 'assert' ||
        typeof entry.namespace !== 'string' ||
        !selected.has(entry.namespace) ||
        typeof entry.opId !== 'string' ||
        typeof entry.ts !== 'string' ||
        !Array.isArray(entry.added)
      ) {
        continue;
      }
      for (const serialized of entry.added) {
        if (typeof serialized !== 'string') continue;
        const [clause] = parseProgram(serialized);
        const key = canonicalKey(clause);
        const currentKey = `${entry.namespace}\u0000${key}`;
        if (!current.has(currentKey)) continue;
        latest.set(currentKey, {
          key,
          source: {
            namespace: entry.namespace,
            opId: entry.opId,
            ts: entry.ts,
            ...(typeof entry.sourceText === 'string' ? { text: entry.sourceText } : {}),
            ...(entry.sourceRedacted === true ? { redacted: true } : {}),
          },
        });
      }
    }

    const result = new Map<string, MemorySource[]>();
    for (const { key, source } of latest.values()) {
      const sources = result.get(key) ?? [];
      sources.push(source);
      result.set(key, sources);
    }
    for (const sources of result.values()) {
      sources.sort((left, right) =>
        (namespaceOrder.get(left.namespace) ?? Number.MAX_SAFE_INTEGER) -
          (namespaceOrder.get(right.namespace) ?? Number.MAX_SAFE_INTEGER) ||
        left.opId.localeCompare(right.opId)
      );
    }
    return result;
  }
}
