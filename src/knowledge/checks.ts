import {
  type Clause,
  isComparison,
  isNegation,
  parseQuery,
  serializeTerm,
} from '../engine/index.js';
import { assertBoundedInput } from '../safety.js';
import type { MemorySource } from '../store/store.js';
import {
  explainKnowledge,
  type ExplainKnowledgeOptions,
  type ExplainKnowledgeResult,
} from './graph.js';
import {
  explainWhyNot,
  type ExplainWhyNotResult,
} from './why-not.js';

export const KNOWLEDGE_CHECK_SUITE_VERSION = 1;
export const MAX_KNOWLEDGE_CHECK_SUITE_BYTES = 1024 * 1024;
export const MAX_KNOWLEDGE_CHECKS = 64;
export const MAX_KNOWLEDGE_CHECK_NAME_BYTES = 128;
export const MAX_KNOWLEDGE_CHECK_EXPECTED_ROWS = 10_000;
export const MAX_KNOWLEDGE_CHECK_BINDINGS = 64;

export type KnowledgeCheckExpectation =
  | { kind: 'empty' }
  | { kind: 'nonempty' }
  | {
      kind: 'rows';
      order: 'exact' | 'set';
      rows: Record<string, string>[];
    };

export interface KnowledgeCheck {
  name: string;
  query: string;
  expect: KnowledgeCheckExpectation;
}

export interface KnowledgeCheckSuite {
  version: typeof KNOWLEDGE_CHECK_SUITE_VERSION;
  checks: KnowledgeCheck[];
}

export interface KnowledgeCheckResult {
  name: string;
  query: string;
  status: 'passed' | 'failed';
  expectation: KnowledgeCheckExpectation;
  actualRows: Record<string, string>[];
  missingRows: Record<string, string>[];
  unexpectedRows: Record<string, string>[];
  orderMismatch: boolean;
  explanation?: ExplainKnowledgeResult;
  whyNot?: ExplainWhyNotResult;
}

export interface RunKnowledgeChecksOptions
  extends Omit<ExplainKnowledgeOptions, 'graphSelector' | 'metrics'> {
  includePassingEvidence?: boolean;
}

export interface KnowledgeCheckSuiteResult {
  status: 'passed' | 'failed';
  checkCount: number;
  passedCount: number;
  failedCount: number;
  checks: KnowledgeCheckResult[];
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalBindingValue(value: string, label: string): string {
  let goals;
  try {
    goals = parseQuery(`value(${value})`);
  } catch {
    throw new Error(`${label} must be one canonical ground Datalog term`);
  }
  if (
    goals.length !== 1 ||
    isComparison(goals[0]) ||
    isNegation(goals[0]) ||
    goals[0].args.length !== 1
  ) {
    throw new Error(`${label} must be one canonical ground Datalog term`);
  }
  const term = goals[0].args[0];
  if (term.type !== 'atom' && term.type !== 'num') {
    throw new Error(`${label} must be one canonical ground Datalog term`);
  }
  if (serializeTerm(term) !== value) {
    throw new Error(`${label} must be a canonical Datalog term`);
  }
  return value;
}

function normalizedRow(value: unknown, label: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_KNOWLEDGE_CHECK_BINDINGS) {
    throw new Error(
      `${label} exceeds ${MAX_KNOWLEDGE_CHECK_BINDINGS} bindings`
    );
  }
  if (entries.some(([name, term]) => name.length === 0 || typeof term !== 'string')) {
    throw new Error(`${label} binding names must be non-empty and values must be strings`);
  }
  return Object.fromEntries(
    entries
      .map(([name, term]) => [
        name,
        canonicalBindingValue(term as string, `${label}.${name}`),
      ])
      .sort(([left], [right]) => compareText(left, right))
  ) as Record<string, string>;
}

function rowKey(row: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(row).sort(([left], [right]) => compareText(left, right))
  );
}

function normalizedExpectation(
  value: unknown,
  label: string
): KnowledgeCheckExpectation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'empty' || record.kind === 'nonempty') {
    exactKeys(record, ['kind'], label);
    return { kind: record.kind };
  }
  if (record.kind !== 'rows') {
    throw new Error(`${label} kind must be 'empty', 'nonempty', or 'rows'`);
  }
  exactKeys(record, ['kind', 'order', 'rows'], label);
  if (record.order !== 'exact' && record.order !== 'set') {
    throw new Error(`${label} row order must be 'exact' or 'set'`);
  }
  if (!Array.isArray(record.rows)) throw new Error(`${label}.rows must be an array`);
  const rows = record.rows.map((row, index) =>
    normalizedRow(row, `${label}.rows[${index}]`)
  );
  if (record.order === 'set') {
    const keys = rows.map(rowKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error(`${label}.rows must not contain duplicates in set mode`);
    }
    rows.sort((left, right) => compareText(rowKey(left), rowKey(right)));
  }
  return { kind: 'rows', order: record.order, rows };
}

/** Parse and normalize a standalone suite before any query execution. */
export function parseKnowledgeCheckSuite(
  value: KnowledgeCheckSuite | string
): KnowledgeCheckSuite {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_KNOWLEDGE_CHECK_SUITE_BYTES) {
      throw new Error(
        `knowledge check suite exceeds ${MAX_KNOWLEDGE_CHECK_SUITE_BYTES} bytes`
      );
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('knowledge check suite is not valid JSON');
    }
  } else {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error('knowledge check suite is not JSON serializable');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_KNOWLEDGE_CHECK_SUITE_BYTES) {
      throw new Error(
        `knowledge check suite exceeds ${MAX_KNOWLEDGE_CHECK_SUITE_BYTES} bytes`
      );
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('knowledge check suite must be an object');
  }
  const record = parsed as Record<string, unknown>;
  exactKeys(record, ['version', 'checks'], 'knowledge check suite');
  if (record.version !== KNOWLEDGE_CHECK_SUITE_VERSION) {
    throw new Error(`knowledge check suite version must be ${KNOWLEDGE_CHECK_SUITE_VERSION}`);
  }
  if (!Array.isArray(record.checks)) throw new Error('knowledge check suite checks must be an array');
  if (record.checks.length === 0 || record.checks.length > MAX_KNOWLEDGE_CHECKS) {
    throw new Error(`knowledge check suite must contain 1 to ${MAX_KNOWLEDGE_CHECKS} checks`);
  }
  let expectedRows = 0;
  const names = new Set<string>();
  const checks = record.checks.map((item, index): KnowledgeCheck => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`knowledge check ${index} must be an object`);
    }
    const check = item as Record<string, unknown>;
    exactKeys(check, ['name', 'query', 'expect'], `knowledge check ${index}`);
    if (
      typeof check.name !== 'string' ||
      check.name.length === 0 ||
      Buffer.byteLength(check.name, 'utf8') > MAX_KNOWLEDGE_CHECK_NAME_BYTES
    ) {
      throw new Error(`knowledge check ${index} has an invalid name`);
    }
    if (names.has(check.name)) throw new Error(`knowledge check name '${check.name}' is duplicated`);
    names.add(check.name);
    if (typeof check.query !== 'string') throw new Error(`knowledge check ${index} query must be a string`);
    assertBoundedInput(check.query, `knowledge check '${check.name}' query`);
    const expectation = normalizedExpectation(check.expect, `knowledge check '${check.name}' expect`);
    if (expectation.kind === 'rows') expectedRows += expectation.rows.length;
    if (expectedRows > MAX_KNOWLEDGE_CHECK_EXPECTED_ROWS) {
      throw new Error(
        `knowledge check suite exceeds ${MAX_KNOWLEDGE_CHECK_EXPECTED_ROWS} expected rows`
      );
    }
    return { name: check.name, query: check.query, expect: expectation };
  });
  return { version: KNOWLEDGE_CHECK_SUITE_VERSION, checks };
}

function rowDelta(
  expected: Record<string, string>[],
  actual: Record<string, string>[]
): {
  missingRows: Record<string, string>[];
  unexpectedRows: Record<string, string>[];
} {
  const expectedCounts = new Map<string, number>();
  const actualCounts = new Map<string, number>();
  for (const row of expected) {
    const key = rowKey(row);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  for (const row of actual) {
    const key = rowKey(row);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  const missingRows = expected.flatMap((row) => {
    const key = rowKey(row);
    const remaining = actualCounts.get(key) ?? 0;
    if (remaining > 0) {
      actualCounts.set(key, remaining - 1);
      return [];
    }
    return [row];
  });
  const expectedRemaining = new Map(expectedCounts);
  const unexpectedRows = actual.flatMap((row) => {
    const key = rowKey(row);
    const remaining = expectedRemaining.get(key) ?? 0;
    if (remaining > 0) {
      expectedRemaining.set(key, remaining - 1);
      return [];
    }
    return [row];
  });
  return { missingRows, unexpectedRows };
}

/** Execute every check over one selected immutable clause/source view. */
export function runKnowledgeChecks(
  clauses: Clause[],
  sourceIndex: Map<string, MemorySource[]>,
  suiteValue: KnowledgeCheckSuite | string,
  options: RunKnowledgeChecksOptions = {}
): KnowledgeCheckSuiteResult {
  const suite = parseKnowledgeCheckSuite(suiteValue);
  const { includePassingEvidence = false, ...explainOptions } = options;
  if (typeof includePassingEvidence !== 'boolean') {
    throw new Error('includePassingEvidence must be a boolean');
  }
  const results: KnowledgeCheckResult[] = [];
  for (const check of suite.checks) {
    const explanation = explainKnowledge(
      clauses,
      check.query,
      sourceIndex,
      explainOptions
    );
    const actualRows = explanation.rows.map(({ bindings }) =>
      normalizedRow(bindings, `knowledge check '${check.name}' actual row`)
    );
    let passed: boolean;
    let expectedRows: Record<string, string>[] = [];
    let orderMismatch = false;
    if (check.expect.kind === 'empty') passed = actualRows.length === 0;
    else if (check.expect.kind === 'nonempty') passed = actualRows.length > 0;
    else {
      expectedRows = check.expect.rows;
      if (check.expect.order === 'exact') {
        passed = JSON.stringify(actualRows) === JSON.stringify(expectedRows);
        const sortedActual = [...actualRows].sort((left, right) =>
          compareText(rowKey(left), rowKey(right))
        );
        const sortedExpected = [...expectedRows].sort((left, right) =>
          compareText(rowKey(left), rowKey(right))
        );
        orderMismatch =
          !passed && JSON.stringify(sortedActual) === JSON.stringify(sortedExpected);
      } else {
        const sortedActual = [...actualRows].sort((left, right) =>
          rowKey(left).localeCompare(rowKey(right))
        );
        passed = JSON.stringify(sortedActual) === JSON.stringify(expectedRows);
      }
    }
    const delta =
      check.expect.kind === 'nonempty'
        ? { missingRows: [], unexpectedRows: [] }
        : rowDelta(expectedRows, actualRows);
    const whyNot =
      !passed &&
      actualRows.length === 0 &&
      check.expect.kind !== 'empty'
        ? explainWhyNot(clauses, check.query, sourceIndex, explainOptions)
        : undefined;
    results.push({
      name: check.name,
      query: check.query,
      status: passed ? 'passed' : 'failed',
      expectation: check.expect,
      actualRows,
      missingRows: delta.missingRows,
      unexpectedRows: delta.unexpectedRows,
      orderMismatch,
      ...(!passed || includePassingEvidence ? { explanation } : {}),
      ...(whyNot === undefined ? {} : { whyNot }),
    });
  }
  const passedCount = results.filter(({ status }) => status === 'passed').length;
  return {
    status: passedCount === results.length ? 'passed' : 'failed',
    checkCount: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    checks: results,
  };
}
