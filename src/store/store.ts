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
  type Goal,
  type Literal,
  ParseError,
  canonicalKey,
  isComparison,
  isNegation,
  literalMatches,
  parseProgram,
  parseQuery,
  serializeClause,
  serializeGoal,
} from '../engine/index.js';
import {
  enforceIntegrityCandidate,
  type IntegrityEnforcementOptions,
} from '../knowledge/enforcement.js';

const NAMESPACE_RE = /^[a-z0-9_-]+$/;
const HEADER = '% rembero memory — one Datalog clause per line; edit by hand if you like.\n';
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_ERROR_BYTES = 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 100_000;
const MAX_PENDING_MUTATION_BYTES = 256 * 1024;
export const MAX_HISTORY_EVENTS = 1_000;
const MAX_HISTORY_SOURCE_BYTES = 4_096;
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
  /** Optional atomic reject-on-write policy for this mutation. */
  integrity?: IntegrityEnforcementOptions;
}

export type ValidTimeMode = 'delete' | 'archive_until';

export interface SupersedeResult {
  added: Clause[];
  duplicates: number;
  retracted: number;
  archived: Clause[];
  opId: string;
}

export type MemoryHistoryAction = 'asserted' | 'retracted' | 'superseded';

export interface MemoryHistoryEvent {
  /** One-based journal line. Append order, not timestamp order, is authoritative. */
  sequence: number;
  /** Stable position within a multi-fact journal operation. */
  position: number;
  namespace: string;
  ts: string;
  opId: string;
  action: MemoryHistoryAction;
  clause: string;
  current: boolean;
  sourceText?: string;
  sourceRedacted?: boolean;
  sourceTruncated?: boolean;
  origin?: 'manual' | 'claude-stop';
  previousSourceOpId?: string;
  archivedAs?: string;
  validUntil?: string;
}

export interface MemoryHistory {
  pattern: string;
  namespaces: string[];
  events: MemoryHistoryEvent[];
}

export interface MemoryHistoryOptions {
  namespaces?: string[] | '*';
  limit?: number;
}

export interface TemporalMemorySource {
  kind: 'superseded';
  previousClause: string;
  validUntil: string;
}

export interface MemorySource {
  namespace: string;
  opId: string;
  ts: string;
  text?: string;
  redacted?: boolean;
  temporal?: TemporalMemorySource;
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
  integrity?: IntegrityEnforcementOptions;
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

interface PendingMutation {
  version: 1;
  namespace: string;
  hadPrevious: boolean;
  journalEntry: JournalEntry;
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

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function parseFactPattern(pattern: string, label: string): Literal {
  let goals: Goal[];
  try {
    goals = parseQuery(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ParseError(`${label}: ${message}`);
  }
  if (goals.length !== 1 || isComparison(goals[0]) || isNegation(goals[0])) {
    throw new ParseError(`${label} must be a single literal, e.g. works_at(rahul, _)`);
  }
  return goals[0] as Literal;
}

function parseJournalClause(value: unknown, label: string): Clause {
  if (typeof value !== 'string') throw new Error(`${label} must be a serialized clause`);
  const clauses = parseProgram(value);
  if (clauses.length !== 1) throw new Error(`${label} must contain exactly one clause`);
  return clauses[0];
}

function parseJournalClauseList(value: unknown, label: string): Clause[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((serialized, index) =>
    parseJournalClause(serialized, `${label}[${index}]`)
  );
}

function archiveUntilClause(clause: Clause, validUntil: string): Clause {
  if (clause.body.length !== 0) throw new Error('valid-time supersession accepts ground facts only');
  if (clause.head.predicate.endsWith('_until')) {
    throw new Error(`refusing to archive temporal predicate '${clause.head.predicate}' again`);
  }
  return {
    head: {
      predicate: `${clause.head.predicate}_until`,
      args: [...clause.head.args, { type: 'atom', value: validUntil }],
    },
    body: [],
  };
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  const suffix = '…';
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  const bytes = Buffer.from(value, 'utf8');
  let end = Math.max(0, budget);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: `${bytes.subarray(0, end).toString('utf8')}${suffix}`, truncated: true };
}

function historySourceFields(entry: JournalEntry): Pick<
  MemoryHistoryEvent,
  'sourceText' | 'sourceRedacted' | 'sourceTruncated' | 'origin'
> {
  const fields: Pick<
    MemoryHistoryEvent,
    'sourceText' | 'sourceRedacted' | 'sourceTruncated' | 'origin'
  > = {};
  if (typeof entry.sourceText === 'string') {
    const redacted = redactSensitiveText(entry.sourceText);
    const bounded = truncateUtf8(redacted.text, MAX_HISTORY_SOURCE_BYTES);
    fields.sourceText = bounded.text;
    if (redacted.redacted || entry.sourceRedacted === true) fields.sourceRedacted = true;
    if (bounded.truncated) fields.sourceTruncated = true;
  }
  if (entry.origin === 'manual' || entry.origin === 'claude-stop') fields.origin = entry.origin;
  return fields;
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
  private heldLocks = new Set<string>();

  constructor(private root: string = defaultRoot()) {
    this.withMutationLock(() =>
      this.withLock('journal', () => this.recoverPendingMutationUnlocked())
    );
  }

  createOperationId(): string {
    return randomUUID();
  }

  private withLock<T>(name: string, operation: () => T): T {
    if (this.heldLocks.has(name)) return operation();
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
      this.heldLocks.add(name);
      return operation();
    } finally {
      this.heldLocks.delete(name);
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

  /** Every supported .dl writer participates so an enforcing snapshot cannot race. */
  private withMutationLock<T>(operation: () => T): T {
    return this.withLock('mutation', operation);
  }

  private integrityNamespaces(
    targetNamespace: string,
    options: IntegrityEnforcementOptions
  ): string[] {
    const requested = options.namespaces ?? [targetNamespace];
    const names = requested === '*'
      ? [...new Set([...this.listNamespaces(), targetNamespace])].sort()
      : [...new Set(requested)];
    if (names.length === 0 || names.length > 32) {
      throw new Error('integrity enforcement namespace list must contain 1 to 32 entries');
    }
    for (const namespace of names) this.filePath(namespace);
    if (!names.includes(targetNamespace)) {
      throw new Error(
        `integrity enforcement namespaces must include target '${targetNamespace}'`
      );
    }
    return names;
  }

  private enforceMutation(
    namespace: string,
    currentClauses: Clause[],
    candidateClauses: Clause[],
    addedClauses: Clause[],
    context: MutationContext,
    at: Date,
    temporalByClause: Map<string, TemporalMemorySource> = new Map()
  ): void {
    const options = context.integrity;
    if (options === undefined) return;
    const names = this.integrityNamespaces(namespace, options);
    const baselineClauses = names.flatMap((name) =>
      name === namespace ? currentClauses : this.load(name)
    );
    const candidateView = names.flatMap((name) =>
      name === namespace ? candidateClauses : this.load(name)
    );
    const baselineSources = this.sourcesFor(names);
    const candidateKeys = new Set(candidateClauses.map(canonicalKey));
    const candidateSources = new Map<string, MemorySource[]>();
    const namespaceOrder = new Map(names.map((name, index) => [name, index]));

    for (const [key, sources] of baselineSources) {
      const retained = sources.filter(
        (source) => source.namespace !== namespace || candidateKeys.has(key)
      );
      if (retained.length > 0) candidateSources.set(key, retained);
    }

    const sanitizedSource = context.sourceText === undefined
      ? {}
      : sanitizeJournalDetails({ sourceText: context.sourceText });
    for (const clause of addedClauses) {
      const key = canonicalKey(clause);
      const sources = candidateSources.get(key) ?? [];
      sources.push({
        namespace,
        opId: context.opId ?? '',
        ts: at.toISOString(),
        ...(typeof sanitizedSource.sourceText !== 'string'
          ? {}
          : { text: sanitizedSource.sourceText }),
        ...(sanitizedSource.sourceRedacted === true ? { redacted: true } : {}),
        ...(temporalByClause.get(key) === undefined
          ? {}
          : { temporal: temporalByClause.get(key) }),
      });
      sources.sort(
        (left, right) =>
          (namespaceOrder.get(left.namespace) ?? Number.MAX_SAFE_INTEGER) -
            (namespaceOrder.get(right.namespace) ?? Number.MAX_SAFE_INTEGER) ||
          left.opId.localeCompare(right.opId)
      );
      candidateSources.set(key, sources);
    }

    enforceIntegrityCandidate(
      baselineClauses,
      candidateView,
      baselineSources,
      candidateSources,
      options
    );
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
    let current = '';
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`refusing symbolic-link journal ${path}`);
      if (stat.size > MAX_JOURNAL_BYTES) {
        throw new Error(`journal.log exceeds ${MAX_JOURNAL_BYTES} bytes`);
      }
      current = readFileSync(path, 'utf8');
    }
    const currentBytes = Buffer.byteLength(current, 'utf8');
    const nextBytes = currentBytes + Buffer.byteLength(line, 'utf8');
    if (nextBytes > MAX_JOURNAL_BYTES) {
      throw new Error(`journal.log would exceed ${MAX_JOURNAL_BYTES} bytes`);
    }
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, `${current}${line}`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (error) {
      this.unlinkIfPresent(tmp);
      throw error;
    }
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
      if (entries.length > MAX_JOURNAL_ENTRIES) {
        throw new Error(`journal.log exceeds ${MAX_JOURNAL_ENTRIES} entries`);
      }
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

  private namespaceBody(entry: CachedNamespace): string {
    const facts = entry.clauses.filter((c) => c.body.length === 0);
    const rules = entry.clauses.filter((c) => c.body.length > 0);
    const body = [...facts, ...rules].map(serializeClause).join('\n');
    return `${HEADER}${body}\n`;
  }

  private pendingMutationPath(): string {
    return join(this.root, '.pending-mutation.json');
  }

  private pendingNextPath(): string {
    return join(this.root, '.pending-mutation.next');
  }

  private pendingBackupPath(): string {
    return join(this.root, '.pending-mutation.before');
  }

  private unlinkIfPresent(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private readPendingMutationUnlocked(): PendingMutation | undefined {
    const path = this.pendingMutationPath();
    let text: string;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing symbolic-link pending mutation ${path}`);
      }
      if (stat.size > MAX_PENDING_MUTATION_BYTES) {
        throw new Error(`pending mutation exceeds ${MAX_PENDING_MUTATION_BYTES} bytes`);
      }
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('failed to read pending mutation');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== 1 ||
      typeof (parsed as Record<string, unknown>).namespace !== 'string' ||
      typeof (parsed as Record<string, unknown>).hadPrevious !== 'boolean' ||
      typeof (parsed as Record<string, unknown>).journalEntry !== 'object' ||
      (parsed as Record<string, unknown>).journalEntry === null ||
      Array.isArray((parsed as Record<string, unknown>).journalEntry)
    ) {
      throw new Error('pending mutation has an invalid shape');
    }
    const pending = parsed as PendingMutation;
    this.filePath(pending.namespace);
    if (
      pending.journalEntry.namespace !== pending.namespace ||
      typeof pending.journalEntry.ts !== 'string' ||
      typeof pending.journalEntry.op !== 'string' ||
      typeof pending.journalEntry.opId !== 'string'
    ) {
      throw new Error('pending mutation has an invalid journal entry');
    }
    return pending;
  }

  private recoverPendingMutationUnlocked(): void {
    const pending = this.readPendingMutationUnlocked();
    if (pending === undefined) {
      if (existsSync(this.pendingBackupPath())) {
        throw new Error('orphaned pending mutation backup requires manual recovery');
      }
      // The marker is published before the namespace changes. Without it, an
      // interrupted preparation is safe to discard and must not block writers.
      this.unlinkIfPresent(this.pendingNextPath());
      const markerPrefix = '.pending-mutation.json.tmp-';
      for (const name of readdirSync(this.root)) {
        if (name.startsWith(markerPrefix)) this.unlinkIfPresent(join(this.root, name));
      }
      return;
    }
    const committed = this.readJournalUnlocked().some(
      (entry) => JSON.stringify(entry) === JSON.stringify(pending.journalEntry)
    );

    if (committed) {
      this.completePendingMutationUnlocked(pending);
    } else {
      this.rollbackPendingMutationUnlocked(pending);
    }
  }

  private completePendingMutationUnlocked(pending: PendingMutation): void {
    const target = this.filePath(pending.namespace);
    if (!existsSync(target)) {
      throw new Error('committed pending mutation has no namespace file');
    }
    this.unlinkIfPresent(this.pendingBackupPath());
    this.unlinkIfPresent(this.pendingNextPath());
    this.unlinkIfPresent(this.pendingMutationPath());
    this.cache.delete(pending.namespace);
  }

  private rollbackPendingMutationUnlocked(pending: PendingMutation): void {
    const target = this.filePath(pending.namespace);
    const backup = this.pendingBackupPath();
    if (existsSync(backup)) {
      this.unlinkIfPresent(target);
      renameSync(backup, target);
    } else if (pending.hadPrevious) {
      if (!existsSync(target)) {
        throw new Error('pending mutation lost its previous namespace file');
      }
    } else {
      this.unlinkIfPresent(target);
    }
    this.unlinkIfPresent(this.pendingNextPath());
    this.unlinkIfPresent(this.pendingMutationPath());
    this.cache.delete(pending.namespace);
  }

  private commitMutation(
    namespace: string,
    entry: CachedNamespace,
    journalEntry: JournalEntry
  ): void {
    this.recoverPendingMutationUnlocked();
    const target = this.filePath(namespace);
    const next = this.pendingNextPath();
    const backup = this.pendingBackupPath();
    const pendingPath = this.pendingMutationPath();
    if (existsSync(next) || existsSync(backup) || existsSync(pendingPath)) {
      throw new Error('refusing to overwrite unresolved pending mutation files');
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`refusing symbolic-link namespace file ${target}`);
    }
    const hadPrevious = existsSync(target);
    writeFileSync(next, this.namespaceBody(entry), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    const pending: PendingMutation = {
      version: 1,
      namespace,
      hadPrevious,
      journalEntry,
    };
    const markerTmp = `${pendingPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(markerTmp, `${JSON.stringify(pending)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(markerTmp, pendingPath);
    } catch (error) {
      this.unlinkIfPresent(markerTmp);
      this.unlinkIfPresent(next);
      throw error;
    }

    let journalCommitted = false;
    try {
      if (hadPrevious) renameSync(target, backup);
      renameSync(next, target);
      this.appendJournalUnlocked(journalEntry);
      journalCommitted = true;
      this.completePendingMutationUnlocked(pending);
    } catch (error) {
      try {
        if (journalCommitted) this.recoverPendingMutationUnlocked();
        else this.rollbackPendingMutationUnlocked(pending);
      } catch (recoveryError) {
        const primary = error instanceof Error ? error.message : String(error);
        const recovery = recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError);
        throw new Error(`${primary}; pending mutation recovery failed: ${recovery}`);
      }
      throw error;
    }
    entry.fileStamp = fileStamp(target);
    this.cache.set(namespace, entry);
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
    const at = validDate(context.at ?? new Date(), 'assert timestamp');
    const effectiveContext = { ...context, opId };
    const parsed = typeof clauses === 'string' ? parseProgram(clauses) : clauses;
    return this.withMutationLock(() =>
      this.withNamespaceLock(namespace, () => {
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
          this.enforceMutation(
            namespace,
            loaded.clauses,
            entry.clauses,
            added,
            effectiveContext,
            at
          );
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
            at
          );
          this.withLock('journal', () => {
            const lineBytes = Buffer.byteLength(`${JSON.stringify(journalEntry)}\n`, 'utf8');
            const path = this.journalPath();
            const currentBytes = existsSync(path) ? statSync(path).size : 0;
            if (currentBytes + lineBytes > MAX_JOURNAL_BYTES) {
              throw new Error(`journal.log would exceed ${MAX_JOURNAL_BYTES} bytes`);
            }
            this.commitMutation(namespace, entry, journalEntry);
          });
        }
        return { added, duplicates, opId };
      })
    );
  }

  retract(
    namespace: string,
    pattern: string,
    context: MutationContext = {}
  ): { removed: number; opId: string } {
    const opId = context.opId ?? this.createOperationId();
    const at = validDate(context.at ?? new Date(), 'retract timestamp');
    const effectiveContext = { ...context, opId };
    return this.withMutationLock(() =>
      this.withNamespaceLock(namespace, () => {
        const loaded = this.loadCached(namespace);
        const entry: CachedNamespace = {
          clauses: [...loaded.clauses],
          keys: new Set(loaded.keys),
          fileStamp: loaded.fileStamp,
        };
        let keep: Clause[];
        if (pattern.includes(':-')) {
          // exact rule or integrity-constraint removal by alpha-equivalence
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
        const keptKeys = new Set(keep.map(canonicalKey));
        const removedClauses = entry.clauses.filter(
          (clause) => !keptKeys.has(canonicalKey(clause))
        );
        const removed = removedClauses.length;
        if (removed > 0) {
          this.enforceMutation(
            namespace,
            loaded.clauses,
            keep,
            [],
            effectiveContext,
            at
          );
          const journalEntry = this.createJournalEntry(
            namespace,
            'retract',
            {
              opId,
              pattern,
              removed,
              removedClauses: removedClauses.map(serializeClause),
              ...(context.sourceText === undefined ? {} : { sourceText: context.sourceText }),
              ...(context.origin === undefined ? {} : { origin: context.origin }),
              ...(context.captureId === undefined ? {} : { captureId: context.captureId }),
            },
            at
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
            this.commitMutation(namespace, entry, journalEntry);
          });
        }
        return { removed, opId };
      })
    );
  }

  private latestJournalSourcesUnlocked(namespace: string): Map<string, string> {
    const sources = new Map<string, { clause: Clause; opId: string }>();
    for (const [index, journalEntry] of this.readJournalUnlocked().entries()) {
      const label = `journal.log line ${index + 1}`;
      if (journalEntry.namespace !== namespace) continue;
      if (journalEntry.op === 'assert') {
        if (typeof journalEntry.opId !== 'string') throw new Error(`${label} has no opId`);
        for (const clause of parseJournalClauseList(journalEntry.added, `${label} added`)) {
          sources.set(canonicalKey(clause), { clause, opId: journalEntry.opId });
        }
        continue;
      }
      if (journalEntry.op === 'supersede') {
        if (typeof journalEntry.opId !== 'string') throw new Error(`${label} has no opId`);
        if (
          !Array.isArray(journalEntry.patterns) ||
          journalEntry.patterns.length === 0 ||
          journalEntry.patterns.length > 64 ||
          !journalEntry.patterns.every((value) => typeof value === 'string')
        ) {
          throw new Error(`${label} patterns must be a non-empty string array`);
        }
        journalEntry.patterns.forEach((value, patternIndex) =>
          parseFactPattern(value as string, `${label} patterns[${patternIndex}]`)
        );
        if (!Array.isArray(journalEntry.ended)) throw new Error(`${label} ended must be an array`);
        for (const [endedIndex, ended] of journalEntry.ended.entries()) {
          if (typeof ended !== 'object' || ended === null || Array.isArray(ended)) {
            throw new Error(`${label} ended[${endedIndex}] must be an object`);
          }
          const clause = parseJournalClause(
            (ended as Record<string, unknown>).clause,
            `${label} ended[${endedIndex}].clause`
          );
          sources.delete(canonicalKey(clause));
        }
        for (const clause of parseJournalClauseList(journalEntry.added, `${label} added`)) {
          sources.set(canonicalKey(clause), { clause, opId: journalEntry.opId });
        }
        continue;
      }
      if (journalEntry.op !== 'retract') continue;
      if (Array.isArray(journalEntry.removedClauses)) {
        for (const clause of parseJournalClauseList(
          journalEntry.removedClauses,
          `${label} removedClauses`
        )) {
          sources.delete(canonicalKey(clause));
        }
        continue;
      }
      if (typeof journalEntry.pattern !== 'string') throw new Error(`${label} has no pattern`);
      if (journalEntry.pattern.includes(':-')) {
        const [rule] = parseProgram(journalEntry.pattern);
        sources.delete(canonicalKey(rule));
        continue;
      }
      const pattern = parseFactPattern(journalEntry.pattern, `${label} pattern`);
      for (const [key, candidate] of sources) {
        if (candidate.clause.body.length === 0 && literalMatches(pattern, candidate.clause.head)) {
          sources.delete(key);
        }
      }
    }
    return new Map([...sources].map(([key, value]) => [key, value.opId]));
  }

  /**
   * Atomically end matching ground facts, retain them as ordinary *_until facts,
   * and add their replacements. Append order is the authoritative event order;
   * the timestamp is descriptive valid-time metadata.
   */
  supersede(
    namespace: string,
    patterns: string[],
    replacements: string | Clause[],
    context: MutationContext = {}
  ): SupersedeResult {
    return this.replaceFacts(namespace, patterns, replacements, true, context);
  }

  /** Atomically retract matching ground facts and add their replacements. */
  replace(
    namespace: string,
    patterns: string[],
    replacements: string | Clause[],
    context: MutationContext = {}
  ): SupersedeResult {
    return this.replaceFacts(namespace, patterns, replacements, false, context);
  }

  private replaceFacts(
    namespace: string,
    patterns: string[],
    replacements: string | Clause[],
    archive: boolean,
    context: MutationContext
  ): SupersedeResult {
    if (patterns.length === 0) throw new Error('supersede requires at least one fact pattern');
    if (patterns.length > 64) throw new Error('supersede accepts at most 64 fact patterns');
    const parsedPatterns = patterns.map((pattern) => ({
      literal: parseFactPattern(pattern, 'supersede pattern'),
    }));
    const requestedPatterns = parsedPatterns.map((pattern) => serializeGoal(pattern.literal));
    const parsedReplacements =
      typeof replacements === 'string' ? parseProgram(replacements) : replacements;
    const opId = context.opId ?? this.createOperationId();
    const at = validDate(
      context.at ?? new Date(),
      archive ? 'supersession timestamp' : 'replacement timestamp'
    );
    const validUntil = at.toISOString();
    const requestedReplacementClauses = parsedReplacements.map(serializeClause);
    const effectiveContext = { ...context, opId };

    return this.withMutationLock(() => this.withNamespaceLock(namespace, () => {
      const loaded = this.loadCached(namespace);
      const entry: CachedNamespace = {
        clauses: [...loaded.clauses],
        keys: new Set(loaded.keys),
        fileStamp: loaded.fileStamp,
      };

      return this.withLock('journal', () => {
        const priorOperation = this.readJournalUnlocked().find(
          (journalEntry) =>
            journalEntry.op === 'supersede' &&
            journalEntry.namespace === namespace &&
            journalEntry.opId === opId
        );
        if (priorOperation !== undefined) {
          if (
            !Array.isArray(priorOperation.patterns) ||
            !priorOperation.patterns.every((value) => typeof value === 'string') ||
            !Array.isArray(priorOperation.replacementRequested) ||
            !priorOperation.replacementRequested.every((value) => typeof value === 'string')
          ) {
            throw new Error(`supersede operation '${opId}' has invalid durable parameters`);
          }
          if (
            JSON.stringify(priorOperation.patterns) !==
              JSON.stringify(requestedPatterns) ||
            JSON.stringify(priorOperation.replacementRequested) !==
              JSON.stringify(requestedReplacementClauses) ||
            (priorOperation.validTimeMode ?? 'archive_until') !==
              (archive ? 'archive_until' : 'delete')
          ) {
            throw new Error(`supersede operation '${opId}' was already used for another mutation`);
          }
          if (!Array.isArray(priorOperation.ended)) {
            throw new Error(`supersede operation '${opId}' has invalid ended facts`);
          }
          if (!Array.isArray(priorOperation.archived)) {
            throw new Error(`supersede operation '${opId}' has invalid archived facts`);
          }
          const archived = priorOperation.archived.map((value, index) => {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
              throw new Error(`supersede operation '${opId}' archived[${index}] is invalid`);
            }
            return parseJournalClause(
              (value as Record<string, unknown>).to,
              `supersede operation '${opId}' archived[${index}].to`
            );
          });
          const added = parseJournalClauseList(
            priorOperation.replacementAdded,
            `supersede operation '${opId}' replacementAdded`
          );
          if (
            typeof priorOperation.duplicates !== 'number' ||
            !Number.isSafeInteger(priorOperation.duplicates) ||
            priorOperation.duplicates < 0
          ) {
            throw new Error(`supersede operation '${opId}' has an invalid duplicate count`);
          }
          return {
            added,
            duplicates: priorOperation.duplicates,
            retracted: priorOperation.ended.length,
            archived,
            opId,
          };
        }
        const previousSources = this.latestJournalSourcesUnlocked(namespace);
        const ended: Clause[] = [];
        const endedKeys = new Set<string>();
        for (const { literal } of parsedPatterns) {
          for (const clause of entry.clauses) {
            const key = canonicalKey(clause);
            if (
              clause.body.length === 0 &&
              !endedKeys.has(key) &&
              literalMatches(literal, clause.head)
            ) {
              if (archive) archiveUntilClause(clause, validUntil); // validate before changing state
              endedKeys.add(key);
              ended.push(clause);
            }
          }
        }

        const archives = archive
          ? ended.map((clause) => archiveUntilClause(clause, validUntil))
          : [];
        entry.clauses = entry.clauses.filter((clause) => !endedKeys.has(canonicalKey(clause)));
        entry.keys = new Set(entry.clauses.map(canonicalKey));

        const archivedAdded: Clause[] = [];
        for (const clause of archives) {
          const key = canonicalKey(clause);
          if (!entry.keys.has(key)) {
            entry.keys.add(key);
            entry.clauses.push(clause);
            archivedAdded.push(clause);
          }
        }

        const replacementAdded: Clause[] = [];
        let duplicates = 0;
        for (const clause of parsedReplacements) {
          const key = canonicalKey(clause);
          if (entry.keys.has(key)) {
            duplicates++;
          } else {
            entry.keys.add(key);
            entry.clauses.push(clause);
            replacementAdded.push(clause);
          }
        }

        const allAdded = [...archivedAdded, ...replacementAdded];
        if (ended.length > 0 || allAdded.length > 0) {
          const archivedAddedKeys = new Set(archivedAdded.map(canonicalKey));
          const proposedTemporalSources = new Map<string, TemporalMemorySource>();
          for (const [index, clause] of archives.entries()) {
            const key = canonicalKey(clause);
            if (!archivedAddedKeys.has(key)) continue;
            proposedTemporalSources.set(key, {
              kind: 'superseded',
              previousClause: serializeClause(ended[index]),
              validUntil,
            });
          }
          this.enforceMutation(
            namespace,
            loaded.clauses,
            entry.clauses,
            allAdded,
            effectiveContext,
            at,
            proposedTemporalSources
          );
          const journalEntry = this.createJournalEntry(
            namespace,
            'supersede',
            {
              opId,
              validTimeMode: archive ? 'archive_until' : 'delete',
              patterns: requestedPatterns,
              ended: ended.map((clause) => ({
                clause: serializeClause(clause),
                ...(previousSources.get(canonicalKey(clause)) === undefined
                  ? {}
                  : { sourceOpId: previousSources.get(canonicalKey(clause)) }),
              })),
              archived: archive
                ? ended.map((clause, index) => ({
                    from: serializeClause(clause),
                    to: serializeClause(archives[index]),
                    validUntil,
                  }))
                : [],
              added: allAdded.map(serializeClause),
              replacementRequested: requestedReplacementClauses,
              replacementAdded: replacementAdded.map(serializeClause),
              duplicates,
              ...(context.sourceText === undefined ? {} : { sourceText: context.sourceText }),
              ...(context.origin === undefined ? {} : { origin: context.origin }),
              ...(context.captureId === undefined ? {} : { captureId: context.captureId }),
            },
            at
          );
          const lineBytes = Buffer.byteLength(`${JSON.stringify(journalEntry)}\n`, 'utf8');
          const path = this.journalPath();
          const currentBytes = existsSync(path) ? statSync(path).size : 0;
          if (currentBytes + lineBytes > MAX_JOURNAL_BYTES) {
            throw new Error(`journal.log would exceed ${MAX_JOURNAL_BYTES} bytes`);
          }
          this.commitMutation(namespace, entry, journalEntry);
        }

        return {
          added: replacementAdded,
          duplicates,
          retracted: ended.length,
          archived: archives,
          opId,
        };
      });
    }));
  }

  private retractFactIfSourcedBy(
    namespace: string,
    serialized: string,
    expectedSourceOpId: string,
    context: Required<Pick<MutationContext, 'opId' | 'captureId' | 'at'>> &
      Pick<MutationContext, 'integrity'>
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
        this.enforceMutation(
          namespace,
          loaded.clauses,
          entry.clauses,
          [],
          context,
          context.at
        );
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
        this.commitMutation(namespace, entry, journalEntry);
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

    return this.withMutationLock(() => {
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
    if (options.integrity !== undefined) {
      if (byNamespace.size > 1) {
        throw new Error(
          'integrity-enforced auto-capture pruning accepts one namespace per operation'
        );
      }
      for (const [namespace, selected] of byNamespace) {
        const loaded = this.loadCached(namespace);
        const sources = this.sourcesFor([namespace]);
        const removableKeys = new Set(
          selected.flatMap((selection) => {
            const [clause] = parseProgram(selection.clause);
            const key = canonicalKey(clause);
            const currentSource = sources
              .get(key)
              ?.find((source) => source.namespace === namespace);
            return currentSource?.opId === selection.opId ? [key] : [];
          })
        );
        const candidate = loaded.clauses.filter(
          (clause) => !removableKeys.has(canonicalKey(clause))
        );
        this.enforceMutation(
          namespace,
          loaded.clauses,
          candidate,
          [],
          { opId, integrity: options.integrity },
          at
        );
      }
    }
    for (const [namespace, selected] of byNamespace) {
      let namespaceRemoved = 0;
      for (const selection of selected) {
        namespaceRemoved += this.retractFactIfSourcedBy(
          namespace,
          selection.clause,
          selection.opId,
          {
            opId,
            captureId: selection.captureId,
            at,
            integrity: undefined,
          }
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
    });
  }

  /** Replay the bounded append-only journal into a deterministic fact life story. */
  history(pattern: string, options: MemoryHistoryOptions = {}): MemoryHistory {
    const selector = parseFactPattern(pattern, 'history pattern');
    const requestedLimit = options.limit ?? MAX_HISTORY_EVENTS;
    if (
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MAX_HISTORY_EVENTS
    ) {
      throw new Error(`history limit must be an integer between 1 and ${MAX_HISTORY_EVENTS}`);
    }
    if (options.namespaces !== '*' && (options.namespaces?.length ?? 0) > 32) {
      throw new Error('history namespace list exceeds 32 entries');
    }

    return this.withLock('journal', () => {
      const journal = this.readJournalUnlocked();
      const names =
        options.namespaces === '*'
          ? [...new Set([
              ...this.listNamespaces(),
              ...journal.map((entry) => entry.namespace),
            ])].sort()
          : [...new Set(options.namespaces ?? ['default'])];
      for (const namespace of names) this.filePath(namespace);
      const selected = new Set(names);
      const state = new Map<
        string,
        { clause: Clause; opId: string; sequence: number; position: number }
      >();
      const lastTransition = new Map<string, string>();
      const events: MemoryHistoryEvent[] = [];
      const stateKey = (namespace: string, clause: Clause) =>
        `${namespace}\u0000${canonicalKey(clause)}`;
      const pushEvent = (event: MemoryHistoryEvent) => {
        events.push(event);
        if (events.length > requestedLimit) {
          throw new Error(`history result exceeds ${requestedLimit} events`);
        }
      };

      for (const [lineIndex, journalEntry] of journal.entries()) {
        const sequence = lineIndex + 1;
        const label = `journal.log line ${sequence}`;
        assertIsoTimestamp(journalEntry.ts, `${label} timestamp`);
        if (!NAMESPACE_RE.test(journalEntry.namespace)) {
          throw new Error(`${label} has an invalid namespace`);
        }
        const inScope = selected.has(journalEntry.namespace);
        if (!['assert', 'retract', 'supersede'].includes(journalEntry.op)) continue;
        if (typeof journalEntry.opId !== 'string' || journalEntry.opId.length === 0) {
          throw new Error(`${label} has no opId`);
        }
        const source = historySourceFields(journalEntry);

        if (journalEntry.op === 'assert') {
          const added = parseJournalClauseList(journalEntry.added, `${label} added`);
          for (const [position, clause] of added.entries()) {
            if (inScope) {
              const key = stateKey(journalEntry.namespace, clause);
              const previousSourceOpId = lastTransition.get(key);
              state.set(key, {
                clause,
                opId: journalEntry.opId,
                sequence,
                position,
              });
              lastTransition.set(key, journalEntry.opId);
              if (clause.body.length === 0 && literalMatches(selector, clause.head)) {
                pushEvent({
                  sequence,
                  position,
                  namespace: journalEntry.namespace,
                  ts: journalEntry.ts,
                  opId: journalEntry.opId,
                  action: 'asserted',
                  clause: serializeClause(clause),
                  current: false,
                  ...(previousSourceOpId === undefined ? {} : { previousSourceOpId }),
                  ...source,
                });
              }
            }
          }
          continue;
        }

        if (journalEntry.op === 'retract') {
          if (typeof journalEntry.pattern !== 'string') throw new Error(`${label} has no pattern`);
          if (
            typeof journalEntry.removed !== 'number' ||
            !Number.isSafeInteger(journalEntry.removed) ||
            journalEntry.removed < 0
          ) {
            throw new Error(`${label} has an invalid removed count`);
          }
          let retractionLiteral: Literal | undefined;
          let retractionRuleKey: string | undefined;
          if (journalEntry.pattern.includes(':-')) {
            const rules = parseProgram(journalEntry.pattern);
            if (rules.length !== 1 || rules[0].body.length === 0) {
              throw new Error(`${label} has an invalid rule retraction pattern`);
            }
            retractionRuleKey = canonicalKey(rules[0]);
          } else {
            retractionLiteral = parseFactPattern(journalEntry.pattern, `${label} pattern`);
          }
          let removedClauses: Clause[];
          if (Array.isArray(journalEntry.removedClauses)) {
            removedClauses = parseJournalClauseList(
              journalEntry.removedClauses,
              `${label} removedClauses`
            );
            if (removedClauses.length !== journalEntry.removed) {
              throw new Error(`${label} removedClauses does not match removed count`);
            }
            if (
              removedClauses.some((clause) =>
                retractionRuleKey === undefined
                  ? clause.body.length !== 0 ||
                    retractionLiteral === undefined ||
                    !literalMatches(retractionLiteral, clause.head)
                  : canonicalKey(clause) !== retractionRuleKey
              )
            ) {
              throw new Error(`${label} removedClauses do not match the retraction pattern`);
            }
          } else if (!inScope) {
            removedClauses = [];
          } else if (retractionRuleKey !== undefined) {
            removedClauses = [...state.values()]
              .filter((value) => canonicalKey(value.clause) === retractionRuleKey)
              .map((value) => value.clause);
          } else {
            removedClauses = [...state.values()]
              .filter(
                (value) =>
                  value.clause.body.length === 0 &&
                  retractionLiteral !== undefined &&
                  literalMatches(retractionLiteral, value.clause.head)
              )
              .map((value) => value.clause)
              .sort((left, right) => serializeClause(left).localeCompare(serializeClause(right)));
          }
          for (const [position, clause] of removedClauses.entries()) {
            if (!inScope) continue;
            const key = stateKey(journalEntry.namespace, clause);
            const previousSourceOpId = state.get(key)?.opId ?? lastTransition.get(key);
            state.delete(key);
            lastTransition.set(key, journalEntry.opId);
            if (clause.body.length === 0 && literalMatches(selector, clause.head)) {
              pushEvent({
                sequence,
                position,
                namespace: journalEntry.namespace,
                ts: journalEntry.ts,
                opId: journalEntry.opId,
                action: 'retracted',
                clause: serializeClause(clause),
                current: false,
                ...(previousSourceOpId === undefined ? {} : { previousSourceOpId }),
                ...source,
              });
            }
          }
          continue;
        }

        if (
          !Array.isArray(journalEntry.patterns) ||
          journalEntry.patterns.length === 0 ||
          journalEntry.patterns.length > 64 ||
          !journalEntry.patterns.every((value) => typeof value === 'string')
        ) {
          throw new Error(`${label} patterns must be a non-empty string array`);
        }
        const supersedePatterns = journalEntry.patterns.map((value, patternIndex) =>
          parseFactPattern(value as string, `${label} patterns[${patternIndex}]`)
        );
        if (!Array.isArray(journalEntry.ended)) throw new Error(`${label} ended must be an array`);
        if (!Array.isArray(journalEntry.archived)) {
          throw new Error(`${label} archived must be an array`);
        }
        const validTimeMode = journalEntry.validTimeMode ?? 'archive_until';
        if (validTimeMode !== 'delete' && validTimeMode !== 'archive_until') {
          throw new Error(`${label} has an invalid valid-time mode`);
        }
        if (validTimeMode === 'delete' && journalEntry.archived.length !== 0) {
          throw new Error(`${label} delete replacement cannot contain archives`);
        }
        const archives = new Map<
          string,
          { to: Clause; validUntil: string }
        >();
        for (const [archiveIndex, archive] of journalEntry.archived.entries()) {
          if (typeof archive !== 'object' || archive === null || Array.isArray(archive)) {
            throw new Error(`${label} archived[${archiveIndex}] must be an object`);
          }
          const record = archive as Record<string, unknown>;
          const from = parseJournalClause(record.from, `${label} archived[${archiveIndex}].from`);
          const to = parseJournalClause(record.to, `${label} archived[${archiveIndex}].to`);
          assertIsoTimestamp(record.validUntil, `${label} archived[${archiveIndex}].validUntil`);
          if (record.validUntil !== journalEntry.ts) {
            throw new Error(`${label} archived validUntil must match the event timestamp`);
          }
          const expected = archiveUntilClause(from, record.validUntil);
          if (canonicalKey(expected) !== canonicalKey(to)) {
            throw new Error(`${label} has an inconsistent archived clause`);
          }
          archives.set(canonicalKey(from), { to, validUntil: record.validUntil });
        }

        const ended: Array<{ clause: Clause; sourceOpId?: string }> = [];
        for (const [endedIndex, endedValue] of journalEntry.ended.entries()) {
          if (
            typeof endedValue !== 'object' ||
            endedValue === null ||
            Array.isArray(endedValue)
          ) {
            throw new Error(`${label} ended[${endedIndex}] must be an object`);
          }
          const record = endedValue as Record<string, unknown>;
          const clause = parseJournalClause(record.clause, `${label} ended[${endedIndex}].clause`);
          if (record.sourceOpId !== undefined && typeof record.sourceOpId !== 'string') {
            throw new Error(`${label} ended[${endedIndex}].sourceOpId must be a string`);
          }
          if (
            validTimeMode === 'archive_until' &&
            !archives.has(canonicalKey(clause))
          ) {
            throw new Error(`${label} ended fact has no archived counterpart`);
          }
          if (
            clause.body.length !== 0 ||
            !supersedePatterns.some((pattern) => literalMatches(pattern, clause.head))
          ) {
            throw new Error(`${label} ended fact does not match a supersede pattern`);
          }
          ended.push({
            clause,
            ...(record.sourceOpId === undefined ? {} : { sourceOpId: record.sourceOpId }),
          });
        }
        if (
          validTimeMode === 'archive_until' &&
          archives.size !== ended.length
        ) {
          throw new Error(`${label} archived facts do not match ended facts`);
        }

        for (const [position, endedFact] of ended.entries()) {
          const archive = archives.get(canonicalKey(endedFact.clause));
          if (validTimeMode === 'archive_until' && archive === undefined) {
            throw new Error(`${label} has an incomplete archive mapping`);
          }
          if (inScope) {
            const key = stateKey(journalEntry.namespace, endedFact.clause);
            const activeSourceOpId = state.get(key)?.opId;
            if (
              endedFact.sourceOpId !== undefined &&
              activeSourceOpId !== undefined &&
              endedFact.sourceOpId !== activeSourceOpId
            ) {
              throw new Error(`${label} ended fact has inconsistent source lineage`);
            }
            const previousSourceOpId =
              endedFact.sourceOpId ?? state.get(key)?.opId ?? lastTransition.get(key);
            state.delete(key);
            lastTransition.set(key, journalEntry.opId);
            if (
              endedFact.clause.body.length === 0 &&
              literalMatches(selector, endedFact.clause.head)
            ) {
              pushEvent({
                sequence,
                position,
                namespace: journalEntry.namespace,
                ts: journalEntry.ts,
                opId: journalEntry.opId,
                action: validTimeMode === 'archive_until' ? 'superseded' : 'retracted',
                clause: serializeClause(endedFact.clause),
                current: false,
                ...(previousSourceOpId === undefined ? {} : { previousSourceOpId }),
                ...(archive === undefined
                  ? {}
                  : {
                      archivedAs: serializeClause(archive.to),
                      validUntil: archive.validUntil,
                    }),
                ...source,
              });
            }
          }
        }

        const added = parseJournalClauseList(journalEntry.added, `${label} added`);
        const replacementRequested = parseJournalClauseList(
          journalEntry.replacementRequested,
          `${label} replacementRequested`
        );
        const replacementAdded = parseJournalClauseList(
          journalEntry.replacementAdded,
          `${label} replacementAdded`
        );
        if (
          typeof journalEntry.duplicates !== 'number' ||
          !Number.isSafeInteger(journalEntry.duplicates) ||
          journalEntry.duplicates < 0 ||
          replacementAdded.length + journalEntry.duplicates !== replacementRequested.length
        ) {
          throw new Error(`${label} has inconsistent replacement counts`);
        }
        const allowedAdded = new Set([
          ...replacementAdded.map(canonicalKey),
          ...[...archives.values()].map((archive) => canonicalKey(archive.to)),
        ]);
        const addedKeys = new Set(added.map(canonicalKey));
        if (
          added.some((clause) => !allowedAdded.has(canonicalKey(clause))) ||
          replacementAdded.some((clause) => !addedKeys.has(canonicalKey(clause)))
        ) {
          throw new Error(`${label} has inconsistent added facts`);
        }
        for (const [addedIndex, clause] of added.entries()) {
          const position = ended.length + addedIndex;
          if (inScope) {
            const key = stateKey(journalEntry.namespace, clause);
            const previousSourceOpId = lastTransition.get(key);
            state.set(key, {
              clause,
              opId: journalEntry.opId,
              sequence,
              position,
            });
            lastTransition.set(key, journalEntry.opId);
            if (clause.body.length === 0 && literalMatches(selector, clause.head)) {
              pushEvent({
                sequence,
                position,
                namespace: journalEntry.namespace,
                ts: journalEntry.ts,
                opId: journalEntry.opId,
                action: 'asserted',
                clause: serializeClause(clause),
                current: false,
                ...(previousSourceOpId === undefined ? {} : { previousSourceOpId }),
                ...source,
              });
            }
          }
        }
      }

      const currentKeys = new Set<string>();
      for (const namespace of names) {
        for (const clause of this.load(namespace)) {
          currentKeys.add(stateKey(namespace, clause));
        }
      }
      for (const event of events) {
        if (event.action !== 'asserted') continue;
        const clause = parseJournalClause(event.clause, 'history event clause');
        const key = stateKey(event.namespace, clause);
        const active = state.get(key);
        event.current =
          currentKeys.has(key) &&
          active?.sequence === event.sequence &&
          active.position === event.position &&
          active.opId === event.opId;
      }

      return {
        pattern: serializeGoal(selector),
        namespaces: names,
        events,
      };
    });
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
    for (const [index, entry] of entries.entries()) {
      if (entry.op !== 'assert' && entry.op !== 'supersede') continue;
      if (!selected.has(entry.namespace)) continue;
      const label = `journal.log line ${index + 1}`;
      if (typeof entry.opId !== 'string') throw new Error(`${label} has no opId`);
      assertIsoTimestamp(entry.ts, `${label} timestamp`);
      const temporalByClause = new Map<string, TemporalMemorySource>();
      if (entry.op === 'supersede') {
        if (!Array.isArray(entry.archived)) throw new Error(`${label} archived must be an array`);
        for (const [archiveIndex, archived] of entry.archived.entries()) {
          if (typeof archived !== 'object' || archived === null || Array.isArray(archived)) {
            throw new Error(`${label} archived[${archiveIndex}] must be an object`);
          }
          const record = archived as Record<string, unknown>;
          const previous = parseJournalClause(
            record.from,
            `${label} archived[${archiveIndex}].from`
          );
          const archivedClause = parseJournalClause(
            record.to,
            `${label} archived[${archiveIndex}].to`
          );
          assertIsoTimestamp(
            record.validUntil,
            `${label} archived[${archiveIndex}].validUntil`
          );
          if (record.validUntil !== entry.ts) {
            throw new Error(`${label} archived validUntil must match the event timestamp`);
          }
          if (
            canonicalKey(archiveUntilClause(previous, record.validUntil)) !==
            canonicalKey(archivedClause)
          ) {
            throw new Error(`${label} has an inconsistent archived clause`);
          }
          temporalByClause.set(canonicalKey(archivedClause), {
            kind: 'superseded',
            previousClause: serializeClause(previous),
            validUntil: record.validUntil,
          });
        }
      }
      for (const clause of parseJournalClauseList(entry.added, `${label} added`)) {
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
            ...(temporalByClause.get(key) === undefined
              ? {}
              : { temporal: temporalByClause.get(key) }),
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
