import { createHash } from 'node:crypto';
import {
  type Clause,
  canonicalKey,
  parseProgram,
  serializeClause,
} from '../engine/index.js';
import {
  MAX_OUTPUT_BYTES,
  assertBoundedOutput,
} from '../safety.js';
import type {
  MemorySource,
  MemoryStore,
  RecordedKnowledgeSnapshot,
} from '../store/store.js';

export const KNOWLEDGE_BUNDLE_FORMAT = 'rembero-knowledge-bundle';
export const KNOWLEDGE_BUNDLE_VERSION = 1;
export const MAX_KNOWLEDGE_BUNDLE_BYTES = MAX_OUTPUT_BYTES;
export const MAX_KNOWLEDGE_BUNDLE_NAMESPACES = 32;
export const MAX_KNOWLEDGE_BUNDLE_CLAUSES = 100_000;
export const MAX_KNOWLEDGE_BUNDLE_SOURCES = 200_000;
const NAMESPACE_RE = /^[a-z0-9_-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type KnowledgeBundleView =
  | { kind: 'current' }
  | { kind: 'recorded'; sequence: number; journalEntries: number };

export interface KnowledgeBundleClause {
  clause: string;
  sources: MemorySource[];
}

export interface KnowledgeBundleNamespace {
  namespace: string;
  clauses: KnowledgeBundleClause[];
}

export interface KnowledgeBundle {
  format: typeof KNOWLEDGE_BUNDLE_FORMAT;
  version: typeof KNOWLEDGE_BUNDLE_VERSION;
  view: KnowledgeBundleView;
  namespaces: KnowledgeBundleNamespace[];
  sha256: string;
}

export interface CreateKnowledgeBundleOptions {
  namespaces?: string[] | '*';
  recordedSequence?: number;
}

export interface KnowledgeBundleVerification {
  valid: true;
  sha256: string;
  view: KnowledgeBundleView;
  namespaces: string[];
  namespaceCount: number;
  clauseCount: number;
  sourceCount: number;
  bytes: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function normalizedSource(value: unknown, namespace: string, label: string): MemorySource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const source = value as Record<string, unknown>;
  const allowed = [
    'namespace',
    'opId',
    'ts',
    'text',
    'redacted',
    'temporal',
    'trustAction',
  ];
  const unexpected = Object.keys(source).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} has unexpected field '${unexpected}'`);
  if (source.namespace !== namespace) {
    throw new Error(`${label} namespace must match '${namespace}'`);
  }
  if (
    typeof source.opId !== 'string' ||
    source.opId.length === 0 ||
    Buffer.byteLength(source.opId, 'utf8') > 256
  ) {
    throw new Error(`${label} has an invalid operation id`);
  }
  const ts = canonicalTimestamp(source.ts, `${label}.ts`);
  if (source.text !== undefined && typeof source.text !== 'string') {
    throw new Error(`${label}.text must be a string`);
  }
  if (source.redacted !== undefined && source.redacted !== true) {
    throw new Error(`${label}.redacted must be true when present`);
  }
  let temporal: MemorySource['temporal'];
  if (source.temporal !== undefined) {
    if (
      typeof source.temporal !== 'object' ||
      source.temporal === null ||
      Array.isArray(source.temporal)
    ) {
      throw new Error(`${label}.temporal must be an object`);
    }
    const record = source.temporal as Record<string, unknown>;
    exactKeys(record, ['kind', 'previousClause', 'validUntil'], `${label}.temporal`);
    if (
      record.kind !== 'superseded' ||
      typeof record.previousClause !== 'string'
    ) {
      throw new Error(`${label}.temporal is invalid`);
    }
    const parsed = parseProgram(record.previousClause);
    if (
      parsed.length !== 1 ||
      parsed[0].body.length !== 0 ||
      serializeClause(parsed[0]) !== record.previousClause
    ) {
      throw new Error(`${label}.temporal.previousClause must be canonical`);
    }
    temporal = {
      kind: 'superseded',
      previousClause: record.previousClause,
      validUntil: canonicalTimestamp(
        record.validUntil,
        `${label}.temporal.validUntil`
      ),
    };
    if (temporal.validUntil !== ts) {
      throw new Error(`${label}.temporal.validUntil must match source timestamp`);
    }
  }
  if (
    source.trustAction !== undefined &&
    source.trustAction !== 'accept' &&
    source.trustAction !== 'reject'
  ) {
    throw new Error(`${label}.trustAction is invalid`);
  }
  return {
    namespace,
    opId: source.opId,
    ts,
    ...(source.text === undefined ? {} : { text: source.text as string }),
    ...(source.redacted === true ? { redacted: true } : {}),
    ...(temporal === undefined ? {} : { temporal }),
    ...(source.trustAction === undefined
      ? {}
      : { trustAction: source.trustAction as 'accept' | 'reject' }),
  };
}

function sourceOrder(left: MemorySource, right: MemorySource): number {
  return (
    compareText(left.ts, right.ts) ||
    compareText(left.opId, right.opId) ||
    compareText(JSON.stringify(left), JSON.stringify(right))
  );
}

function normalizedView(value: unknown): KnowledgeBundleView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('knowledge bundle view must be an object');
  }
  const view = value as Record<string, unknown>;
  if (view.kind === 'current') {
    exactKeys(view, ['kind'], 'knowledge bundle view');
    return { kind: 'current' };
  }
  if (view.kind !== 'recorded') throw new Error('knowledge bundle view kind is invalid');
  exactKeys(view, ['kind', 'sequence', 'journalEntries'], 'knowledge bundle view');
  if (
    !Number.isSafeInteger(view.sequence) ||
    !Number.isSafeInteger(view.journalEntries) ||
    (view.sequence as number) < 0 ||
    (view.journalEntries as number) < (view.sequence as number)
  ) {
    throw new Error('knowledge bundle recorded coordinates are invalid');
  }
  return {
    kind: 'recorded',
    sequence: view.sequence as number,
    journalEntries: view.journalEntries as number,
  };
}

function normalizedNamespaces(value: unknown): {
  namespaces: KnowledgeBundleNamespace[];
  clauseCount: number;
  sourceCount: number;
} {
  if (!Array.isArray(value)) throw new Error('knowledge bundle namespaces must be an array');
  if (value.length > MAX_KNOWLEDGE_BUNDLE_NAMESPACES) {
    throw new Error(
      `knowledge bundle exceeds ${MAX_KNOWLEDGE_BUNDLE_NAMESPACES} namespaces`
    );
  }
  const namespaces: KnowledgeBundleNamespace[] = [];
  let clauseCount = 0;
  let sourceCount = 0;
  let previousNamespace = '';
  for (const [namespaceIndex, item] of value.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`knowledge bundle namespaces[${namespaceIndex}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    exactKeys(record, ['namespace', 'clauses'], `knowledge bundle namespaces[${namespaceIndex}]`);
    if (typeof record.namespace !== 'string' || !NAMESPACE_RE.test(record.namespace)) {
      throw new Error(`knowledge bundle namespaces[${namespaceIndex}] has invalid namespace`);
    }
    if (compareText(record.namespace, previousNamespace) <= 0) {
      throw new Error('knowledge bundle namespaces must be strictly sorted');
    }
    previousNamespace = record.namespace;
    if (!Array.isArray(record.clauses)) {
      throw new Error(`knowledge bundle namespace '${record.namespace}' clauses must be an array`);
    }
    const clauses: KnowledgeBundleClause[] = [];
    let previousClause = '';
    for (const [clauseIndex, itemClause] of record.clauses.entries()) {
      if (
        typeof itemClause !== 'object' ||
        itemClause === null ||
        Array.isArray(itemClause)
      ) {
        throw new Error(`knowledge bundle clause ${clauseIndex} must be an object`);
      }
      const clauseRecord = itemClause as Record<string, unknown>;
      exactKeys(clauseRecord, ['clause', 'sources'], `knowledge bundle clause ${clauseIndex}`);
      if (typeof clauseRecord.clause !== 'string') {
        throw new Error(`knowledge bundle clause ${clauseIndex} must be a string`);
      }
      const parsed = parseProgram(clauseRecord.clause);
      if (parsed.length !== 1 || serializeClause(parsed[0]) !== clauseRecord.clause) {
        throw new Error(`knowledge bundle clause ${clauseIndex} must be canonical`);
      }
      if (compareText(clauseRecord.clause, previousClause) <= 0) {
        throw new Error('knowledge bundle clauses must be strictly sorted');
      }
      previousClause = clauseRecord.clause;
      if (!Array.isArray(clauseRecord.sources)) {
        throw new Error(`knowledge bundle clause ${clauseIndex} sources must be an array`);
      }
      const sources = clauseRecord.sources.map((source, sourceIndex) =>
        normalizedSource(
          source,
          record.namespace as string,
          `knowledge bundle clause ${clauseIndex} sources[${sourceIndex}]`
        )
      );
      const sorted = [...sources].sort(sourceOrder);
      if (JSON.stringify(sorted) !== JSON.stringify(sources)) {
        throw new Error('knowledge bundle sources must be canonically sorted');
      }
      if (
        sources.some(
          (source, index) =>
            index > 0 && JSON.stringify(source) === JSON.stringify(sources[index - 1])
        )
      ) {
        throw new Error('knowledge bundle sources must not contain duplicates');
      }
      sourceCount += sources.length;
      clauseCount += 1;
      if (clauseCount > MAX_KNOWLEDGE_BUNDLE_CLAUSES) {
        throw new Error(
          `knowledge bundle exceeds ${MAX_KNOWLEDGE_BUNDLE_CLAUSES} clauses`
        );
      }
      if (sourceCount > MAX_KNOWLEDGE_BUNDLE_SOURCES) {
        throw new Error(
          `knowledge bundle exceeds ${MAX_KNOWLEDGE_BUNDLE_SOURCES} sources`
        );
      }
      clauses.push({ clause: clauseRecord.clause, sources });
    }
    namespaces.push({ namespace: record.namespace, clauses });
  }
  return { namespaces, clauseCount, sourceCount };
}

function canonicalBody(
  view: KnowledgeBundleView,
  namespaces: KnowledgeBundleNamespace[]
) {
  return {
    format: KNOWLEDGE_BUNDLE_FORMAT,
    version: KNOWLEDGE_BUNDLE_VERSION,
    view,
    namespaces,
  } as const;
}

function parsedBundle(value: unknown): {
  bundle: KnowledgeBundle;
  clauseCount: number;
  sourceCount: number;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('knowledge bundle must be an object');
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, ['format', 'version', 'view', 'namespaces', 'sha256'], 'knowledge bundle');
  if (
    record.format !== KNOWLEDGE_BUNDLE_FORMAT ||
    record.version !== KNOWLEDGE_BUNDLE_VERSION ||
    typeof record.sha256 !== 'string' ||
    !SHA256_RE.test(record.sha256)
  ) {
    throw new Error('knowledge bundle identity is invalid');
  }
  const view = normalizedView(record.view);
  const normalized = normalizedNamespaces(record.namespaces);
  const body = canonicalBody(view, normalized.namespaces);
  const expected = digest(JSON.stringify(body));
  if (record.sha256 !== expected) throw new Error('knowledge bundle failed SHA-256 validation');
  return {
    bundle: { ...body, sha256: expected },
    clauseCount: normalized.clauseCount,
    sourceCount: normalized.sourceCount,
  };
}

function namespaceEntries(
  namespace: string,
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]>
): KnowledgeBundleNamespace {
  const seen = new Set<string>();
  const entries: KnowledgeBundleClause[] = [];
  for (const clause of clauses) {
    const key = canonicalKey(clause);
    if (seen.has(key)) continue;
    seen.add(key);
    const sources = (sourceIndex.get(key) ?? [])
      .filter((source) => source.namespace === namespace)
      .map((source) => structuredClone(source))
      .sort(sourceOrder);
    entries.push({ clause: serializeClause(clause), sources });
  }
  entries.sort((left, right) => compareText(left.clause, right.clause));
  return { namespace, clauses: entries };
}

function recordedNamespaceClauses(
  snapshot: RecordedKnowledgeSnapshot,
  namespace: string
): Clause[] {
  const keys = new Set(
    [...snapshot.sources]
      .filter(([, sources]) => sources.some((source) => source.namespace === namespace))
      .map(([key]) => key)
  );
  return snapshot.clauses.filter((clause) => keys.has(canonicalKey(clause)));
}

/** Export raw namespace authority and provenance as one deterministic bundle. */
export function createKnowledgeBundle(
  store: MemoryStore,
  options: CreateKnowledgeBundleOptions = {}
): KnowledgeBundle {
  const requested = options.namespaces ?? '*';
  let view: KnowledgeBundleView;
  let namespaces: KnowledgeBundleNamespace[];
  if (options.recordedSequence === undefined) {
    const snapshot = store.knowledgeSnapshot(requested);
    view = { kind: 'current' };
    namespaces = snapshot.namespaces.map((namespace) =>
      namespaceEntries(
        namespace,
        snapshot.clausesByNamespace.get(namespace) ?? [],
        snapshot.sources
      )
    );
  } else {
    const snapshot = store.recordedSnapshot(requested, options.recordedSequence);
    view = {
      kind: 'recorded',
      sequence: snapshot.sequence,
      journalEntries: snapshot.journalEntries,
    };
    namespaces = snapshot.namespaces.map((namespace) =>
      namespaceEntries(
        namespace,
        recordedNamespaceClauses(snapshot, namespace),
        snapshot.sources
      )
    );
  }
  namespaces.sort((left, right) => compareText(left.namespace, right.namespace));
  const body = canonicalBody(view, namespaces);
  const bundle: KnowledgeBundle = {
    ...body,
    sha256: digest(JSON.stringify(body)),
  };
  // Run the same standalone verifier before returning an artifact.
  verifyKnowledgeBundle(bundle);
  return bundle;
}

export function serializeKnowledgeBundle(bundle: KnowledgeBundle): string {
  const verified = parsedBundle(bundle).bundle;
  const text = JSON.stringify(verified);
  assertBoundedOutput(text, 'knowledge bundle', MAX_KNOWLEDGE_BUNDLE_BYTES);
  return text;
}

/** Verify structure, canonical encoding, resource bounds, provenance, and content digest. */
export function verifyKnowledgeBundle(
  value: KnowledgeBundle | string
): KnowledgeBundleVerification {
  let parsed: unknown = value;
  let bytes: number;
  if (typeof value === 'string') {
    bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_KNOWLEDGE_BUNDLE_BYTES) {
      throw new Error(`knowledge bundle exceeds ${MAX_KNOWLEDGE_BUNDLE_BYTES} bytes`);
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('knowledge bundle is not valid JSON');
    }
  } else {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > MAX_KNOWLEDGE_BUNDLE_BYTES) {
      throw new Error(`knowledge bundle exceeds ${MAX_KNOWLEDGE_BUNDLE_BYTES} bytes`);
    }
  }
  const result = parsedBundle(parsed);
  const canonical = JSON.stringify(result.bundle);
  assertBoundedOutput(canonical, 'knowledge bundle', MAX_KNOWLEDGE_BUNDLE_BYTES);
  return {
    valid: true,
    sha256: result.bundle.sha256,
    view: result.bundle.view,
    namespaces: result.bundle.namespaces.map(({ namespace }) => namespace),
    namespaceCount: result.bundle.namespaces.length,
    clauseCount: result.clauseCount,
    sourceCount: result.sourceCount,
    bytes: Buffer.byteLength(canonical, 'utf8'),
  };
}
