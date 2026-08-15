import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type Clause,
  type Literal,
  ParseError,
  canonicalKey,
  isComparison,
  literalMatches,
  parseProgram,
  parseQuery,
  serializeClause,
} from '../engine/index.js';

const NAMESPACE_RE = /^[a-z0-9_-]+$/;
const HEADER = '% rembero memory — one Datalog clause per line; edit by hand if you like.\n';

export interface AssertResult {
  added: Clause[];
  duplicates: number;
}

interface CachedNamespace {
  clauses: Clause[];
  keys: Set<string>;
  /** mtime+size of the file this cache was read from; '' when the file did not exist. */
  fileStamp: string;
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

export class MemoryStore {
  private cache = new Map<string, CachedNamespace>();

  constructor(private root: string = join(homedir(), '.rembero', 'memory')) {}

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

  assert(namespace: string, clauses: string | Clause[]): AssertResult {
    const parsed = typeof clauses === 'string' ? parseProgram(clauses) : clauses;
    const entry = this.loadCached(namespace);
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
    if (added.length > 0) this.save(namespace, entry);
    return { added, duplicates };
  }

  retract(namespace: string, pattern: string): { removed: number } {
    const entry = this.loadCached(namespace);
    let keep: Clause[];
    if (pattern.includes(':-')) {
      // exact rule removal by alpha-equivalence
      const [rule] = parseProgram(pattern);
      const key = canonicalKey(rule);
      keep = entry.clauses.filter((c) => canonicalKey(c) !== key);
    } else {
      const goals = parseQuery(pattern);
      if (goals.length !== 1 || isComparison(goals[0])) {
        throw new ParseError('forget pattern must be a single literal, e.g. works_at(rahul, _)');
      }
      const literal = goals[0] as Literal;
      keep = entry.clauses.filter(
        (c) => c.body.length > 0 || !literalMatches(literal, c.head)
      );
    }
    const removed = entry.clauses.length - keep.length;
    if (removed > 0) {
      entry.clauses = keep;
      entry.keys = new Set(keep.map(canonicalKey));
      this.cache.set(namespace, entry);
      this.save(namespace, entry);
    }
    return { removed };
  }

  listNamespaces(): string[] {
    let files: string[];
    try {
      files = readdirSync(this.root);
    } catch {
      return [];
    }
    return files.filter((f) => f.endsWith('.dl')).map((f) => f.slice(0, -3));
  }

  clausesFor(namespaces: string[] | '*'): Clause[] {
    const names = namespaces === '*' ? this.listNamespaces() : namespaces;
    return names.flatMap((ns) => this.load(ns));
  }
}
