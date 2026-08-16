import {
  type Clause,
  type CmpOp,
  type Comparison,
  type Goal,
  type Literal,
  type AggregateOperator,
  type AggregateQuerySpec,
  type QuerySpec,
  type ScalarExpression,
  type Term,
  MAX_ARITHMETIC_EXPRESSION_DEPTH,
  MAX_ARITHMETIC_EXPRESSION_NODES,
  isArithmeticExpression,
  isComparison,
  isNegation,
} from './ast.js';
import { stratifyProgram } from './stratify.js';

export type Bindings = Record<string, Term>;

export interface DerivationProof {
  predicate: string;
  values: (string | number)[];
  rule?: number;
  because?: ProofStep[];
}

export interface AbsenceProof {
  negated: true;
  predicate: string;
  /** Grounded arguments; null represents an existential wildcard. */
  pattern: (string | number | null)[];
  stratum: number;
}

export type ProofStep = DerivationProof | AbsenceProof;

export interface AggregateContribution {
  bindings: Bindings;
  proofs: ProofStep[];
}

export interface AggregateProof {
  aggregated: true;
  op: AggregateOperator;
  input: '*' | string;
  as: string;
  value: string | number;
  contributors: AggregateContribution[];
  /** Contributor indexes equal to the selected min/max value, in stable query order. */
  witnessPositions?: number[];
}

export type QueryProof = ProofStep | AggregateProof;

export interface ExplainedBindings {
  bindings: Bindings;
  proofs: ProofStep[];
}

export interface ExplainedQueryBindings {
  bindings: Bindings;
  proofs: QueryProof[];
}

export interface MaterializedFactWithProof {
  predicate: string;
  values: (string | number)[];
  derived: boolean;
  proof: DerivationProof;
}

export class EngineLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineLimitError';
  }
}

export class EngineSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineSafetyError';
  }
}

export interface EvaluateOptions {
  maxFacts?: number;
  maxIterations?: number;
  maxRows?: number;
  /** Maximum candidate rows inspected before an exact aggregate fails closed. */
  maxAggregateRows?: number;
  /** Maximum contributor rows retained in an aggregate explanation. */
  maxAggregateProofRows?: number;
  maxProofDepth?: number;
  maxProofNodes?: number;
}

interface FactEntry {
  predicate: string;
  tuple: Term[];
  derived: boolean;
  rule?: number;
  because?: ProofRef[];
}

type ProofRef = FactEntry | AbsenceProof;

interface GoalSolution {
  env: Bindings;
  proofs: ProofRef[];
}

interface QueryRowRef {
  bindings: Bindings;
  proofs: ProofRef[];
}

/** Ground tuples per predicate, keyed for O(1) dedup while preserving insertion order. */
type Relation = Map<string, FactEntry>;
type Database = Map<string, Relation>;

const litKey = (predicate: string, arity: number) => `${predicate}/${arity}`;

function keyPart(term: Term): readonly [string, string | number] {
  switch (term.type) {
    case 'atom':
      return ['atom', term.value];
    case 'num':
      return ['num', term.value];
    case 'var':
      return ['var', term.name];
    case 'wildcard':
      return ['wildcard', '_'];
  }
}

function tupleKey(args: Term[]): string {
  return JSON.stringify(args.map(keyPart));
}

function assertFiniteNumericTerm(term: Term): void {
  if (term.type === 'num' && !Number.isFinite(term.value)) {
    throw new EngineSafetyError('numeric terms must be finite');
  }
}

function assertExpressionSafety(
  expression: ScalarExpression,
  budget: { nodes: number } = { nodes: 0 }
): void {
  const pending: Array<{ expression: ScalarExpression; depth: number }> = [
    { expression, depth: 1 },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_ARITHMETIC_EXPRESSION_DEPTH) {
      throw new EngineLimitError(
        `arithmetic expression exceeded depth ${MAX_ARITHMETIC_EXPRESSION_DEPTH}`
      );
    }
    if (++budget.nodes > MAX_ARITHMETIC_EXPRESSION_NODES) {
      throw new EngineLimitError(
        `arithmetic expression exceeded ${MAX_ARITHMETIC_EXPRESSION_NODES} nodes`
      );
    }
    if (!isArithmeticExpression(current.expression)) {
      assertFiniteNumericTerm(current.expression);
      continue;
    }
    if (current.expression.kind === 'unary') {
      pending.push({
        expression: current.expression.operand,
        depth: current.depth + 1,
      });
    } else {
      pending.push(
        { expression: current.expression.right, depth: current.depth + 1 },
        { expression: current.expression.left, depth: current.depth + 1 }
      );
    }
  }
}

function assertGoalNumericSafety(goal: Goal): void {
  if (isComparison(goal)) {
    const budget = { nodes: 0 };
    assertExpressionSafety(goal.left, budget);
    assertExpressionSafety(goal.right, budget);
    return;
  }
  for (const term of (isNegation(goal) ? goal.not.args : goal.args)) {
    assertFiniteNumericTerm(term);
  }
}

function assertGoalsNumericSafety(goals: Goal[]): void {
  for (const goal of goals) assertGoalNumericSafety(goal);
}

function termEq(a: Term, b: Term): boolean {
  assertFiniteNumericTerm(a);
  assertFiniteNumericTerm(b);
  if (a.type === 'num' && b.type === 'num') return a.value === b.value;
  if (a.type === 'atom' && b.type === 'atom') return a.value === b.value;
  return false;
}

function ordered(op: CmpOp, cmp: number): boolean {
  switch (op) {
    case '<':
      return cmp < 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '>=':
      return cmp >= 0;
    default:
      return false;
  }
}

function comparisonHolds(op: CmpOp, left: Term, right: Term): boolean {
  assertFiniteNumericTerm(left);
  assertFiniteNumericTerm(right);
  if (op === '=') return termEq(left, right);
  if (op === '!=') {
    // != only meaningfully compares two ground terms of the same type
    if (left.type === 'num' && right.type === 'num') return left.value !== right.value;
    if (left.type === 'atom' && right.type === 'atom') return left.value !== right.value;
    return true;
  }
  if (left.type === 'num' && right.type === 'num') {
    return ordered(op, left.value === right.value ? 0 : left.value < right.value ? -1 : 1);
  }
  if (left.type === 'atom' && right.type === 'atom') {
    return ordered(op, left.value === right.value ? 0 : left.value < right.value ? -1 : 1);
  }
  return false; // mixed types: goal fails rather than throwing
}

function resolve(term: Term, env: Bindings): Term {
  return term.type === 'var' ? (env[term.name] ?? term) : term;
}

interface ExpressionEvaluationBudget {
  nodes: number;
}

interface EvaluatedExpression {
  term: Term;
  arithmetic: boolean;
}

function numericArithmeticOperand(term: Term): number {
  if (term.type === 'var') {
    throw new EngineSafetyError(`arithmetic variable ${term.name} is not grounded`);
  }
  if (term.type === 'wildcard') {
    throw new EngineSafetyError('arithmetic expressions may not contain wildcards');
  }
  if (term.type !== 'num') {
    throw new EngineSafetyError('arithmetic expressions require numeric operands');
  }
  assertFiniteNumericTerm(term);
  return term.value;
}

function evaluateScalarExpression(
  expression: ScalarExpression,
  env: Bindings,
  budget: ExpressionEvaluationBudget,
  depth = 1
): EvaluatedExpression {
  if (depth > MAX_ARITHMETIC_EXPRESSION_DEPTH) {
    throw new EngineLimitError(
      `arithmetic expression exceeded depth ${MAX_ARITHMETIC_EXPRESSION_DEPTH}`
    );
  }
  if (++budget.nodes > MAX_ARITHMETIC_EXPRESSION_NODES) {
    throw new EngineLimitError(
      `arithmetic expression exceeded ${MAX_ARITHMETIC_EXPRESSION_NODES} nodes`
    );
  }
  if (!isArithmeticExpression(expression)) {
    return { term: resolve(expression, env), arithmetic: false };
  }
  if (expression.kind === 'unary') {
    const operand = evaluateScalarExpression(expression.operand, env, budget, depth + 1);
    const numeric = numericArithmeticOperand(operand.term);
    const result = expression.op === '-' ? -numeric : numeric;
    if (!Number.isFinite(result)) {
      throw new EngineSafetyError('arithmetic expression produced a non-finite result');
    }
    return {
      term: { type: 'num', value: result === 0 ? 0 : result },
      arithmetic: true,
    };
  }

  const left = evaluateScalarExpression(expression.left, env, budget, depth + 1);
  const right = evaluateScalarExpression(expression.right, env, budget, depth + 1);
  const leftValue = numericArithmeticOperand(left.term);
  const rightValue = numericArithmeticOperand(right.term);
  if (expression.op === '/' && rightValue === 0) {
    throw new EngineSafetyError('arithmetic division by zero');
  }
  let result: number;
  switch (expression.op) {
    case '+':
      result = leftValue + rightValue;
      break;
    case '-':
      result = leftValue - rightValue;
      break;
    case '*':
      result = leftValue * rightValue;
      break;
    case '/':
      result = leftValue / rightValue;
      break;
  }
  if (!Number.isFinite(result)) {
    throw new EngineSafetyError('arithmetic expression produced a non-finite result');
  }
  return {
    term: { type: 'num', value: result === 0 ? 0 : result },
    arithmetic: true,
  };
}

function matchArgs(args: Term[], tuple: Term[], env: Bindings): Bindings | null {
  let extended = env;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.type === 'wildcard') continue;
    if (arg.type === 'var') {
      const bound = extended[arg.name];
      if (bound === undefined) {
        if (extended === env) extended = { ...env };
        extended[arg.name] = tuple[i];
      } else if (!termEq(bound, tuple[i])) {
        return null;
      }
    } else if (!termEq(arg, tuple[i])) {
      return null;
    }
  }
  return extended;
}

function checkComparison(goal: Comparison, env: Bindings): boolean {
  const budget: ExpressionEvaluationBudget = { nodes: 0 };
  const leftExpression = evaluateScalarExpression(goal.left, env, budget);
  const rightExpression = evaluateScalarExpression(goal.right, env, budget);
  const left = leftExpression.term;
  const right = rightExpression.term;
  if (left.type === 'var' || left.type === 'wildcard') return false;
  if (right.type === 'var' || right.type === 'wildcard') return false;
  if (
    (leftExpression.arithmetic || rightExpression.arithmetic) &&
    (left.type !== 'num' || right.type !== 'num')
  ) {
    throw new EngineSafetyError(
      'arithmetic comparisons require numeric values on both sides'
    );
  }
  return comparisonHolds(goal.op, left, right);
}

/** Walk goals left-to-right, extending env; `source` picks which relation a goal reads. */
function* solveGoals(
  goals: Goal[],
  index: number,
  env: Bindings,
  proofs: ProofRef[],
  source: (goalIndex: number, key: string) => Relation | undefined,
  stratumOf: (key: string) => number
): Generator<GoalSolution> {
  if (index === goals.length) {
    yield { env, proofs };
    return;
  }
  const goal = goals[index];
  if (isComparison(goal)) {
    if (checkComparison(goal, env)) {
      yield* solveGoals(goals, index + 1, env, proofs, source, stratumOf);
    }
    return;
  }
  if (isNegation(goal)) {
    const key = litKey(goal.not.predicate, goal.not.args.length);
    const resolved = goal.not.args.map((term): Term => {
      const value = resolve(term, env);
      if (value.type === 'var') {
        throw new EngineSafetyError(
          `negated variable ${value.name} is not bound by an earlier positive relation`
        );
      }
      return value;
    });
    const relation = source(index, key);
    if (relation) {
      for (const entry of relation.values()) {
        if (matchArgs(resolved, entry.tuple, {}) !== null) return;
      }
    }
    const absence: AbsenceProof = {
      negated: true,
      predicate: goal.not.predicate,
      pattern: resolved.map((term) =>
        term.type === 'wildcard' ? null : groundValue(term)
      ),
      stratum: stratumOf(key),
    };
    yield* solveGoals(goals, index + 1, env, [...proofs, absence], source, stratumOf);
    return;
  }
  const relation = source(index, litKey(goal.predicate, goal.args.length));
  if (!relation) return;
  for (const entry of relation.values()) {
    const extended = matchArgs(goal.args, entry.tuple, env);
    if (extended) {
      yield* solveGoals(
        goals,
        index + 1,
        extended,
        [...proofs, entry],
        source,
        stratumOf
      );
    }
  }
}

/** Does a ground literal match a pattern that may contain variables/wildcards? */
export function literalMatches(pattern: Literal, fact: Literal): boolean {
  if (pattern.predicate !== fact.predicate) return false;
  if (pattern.args.length !== fact.args.length) return false;
  for (const term of pattern.args) assertFiniteNumericTerm(term);
  for (const term of fact.args) assertFiniteNumericTerm(term);
  return matchArgs(pattern.args, fact.args, {}) !== null;
}

function substituteHead(head: Literal, env: Bindings): Term[] {
  return head.args.map((arg) => resolve(arg, env));
}

function addTuple(db: Database, key: string, entry: FactEntry): boolean {
  let relation = db.get(key);
  if (!relation) {
    relation = new Map();
    db.set(key, relation);
  }
  const tk = tupleKey(entry.tuple);
  if (relation.has(tk)) return false;
  relation.set(tk, entry);
  return true;
}

function groundValue(term: Term): string | number {
  if (term.type === 'atom') return term.value;
  if (term.type === 'num') {
    assertFiniteNumericTerm(term);
    return term.value;
  }
  throw new Error('proof serialization requires grounded facts');
}

interface ProofBudget {
  maxNodes: number;
  emittedNodes: number;
}

function isAbsenceProof(proof: ProofRef): proof is AbsenceProof {
  return 'negated' in proof;
}

function serializeProof(
  entry: FactEntry,
  maxProofDepth: number,
  budget: ProofBudget,
  depth?: number
): DerivationProof;
function serializeProof(
  entry: AbsenceProof,
  maxProofDepth: number,
  budget: ProofBudget,
  depth?: number
): AbsenceProof;
function serializeProof(
  entry: ProofRef,
  maxProofDepth: number,
  budget: ProofBudget,
  depth?: number
): ProofStep;
function serializeProof(
  entry: ProofRef,
  maxProofDepth: number,
  budget: ProofBudget,
  depth = 1
): ProofStep {
  if (depth > maxProofDepth) {
    throw new EngineLimitError(`proof exceeded max depth ${maxProofDepth}`);
  }
  if (++budget.emittedNodes > budget.maxNodes) {
    throw new EngineLimitError(`proof exceeded max nodes ${budget.maxNodes}`);
  }
  if (isAbsenceProof(entry)) return { ...entry, pattern: [...entry.pattern] };
  const proof: DerivationProof = {
    predicate: entry.predicate,
    values: entry.tuple.map(groundValue),
  };
  if (entry.rule !== undefined) proof.rule = entry.rule;
  if (entry.because && entry.because.length > 0) {
    proof.because = entry.because.map((child) =>
      serializeProof(child, maxProofDepth, budget, depth + 1)
    );
  }
  return proof;
}

function rowKey(bindings: Bindings): string {
  return JSON.stringify(
    Object.entries(bindings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, term]) => [name, keyPart(term)])
  );
}

interface DerivedDatabase {
  db: Database;
  predicateStrata: Map<string, number>;
}

function deriveDatabase(clauses: Clause[], options: EvaluateOptions): DerivedDatabase {
  const { maxFacts = 100_000, maxIterations = 10_000 } = options;
  for (const clause of clauses) {
    for (const term of clause.head.args) assertFiniteNumericTerm(term);
    assertGoalsNumericSafety(clause.body);
  }
  const facts = clauses.filter((c) => c.body.length === 0);
  const stratified = stratifyProgram(clauses);

  const db: Database = new Map();
  let totalFacts = 0;

  for (const fact of facts) {
    const key = litKey(fact.head.predicate, fact.head.args.length);
    const entry: FactEntry = {
      predicate: fact.head.predicate,
      tuple: fact.head.args,
      derived: false,
    };
    if (addTuple(db, key, entry)) {
      if (++totalFacts > maxFacts) {
        throw new EngineLimitError(`derivation exceeded ${maxFacts} facts`);
      }
    }
  }

  let iterations = 0;
  const stratumOf = (key: string) => stratified.predicateStrata.get(key) ?? 0;
  for (const rules of stratified.strata) {
    if (rules.length === 0) continue;
    let delta: Database = new Map(db);
    let firstRound = true;
    while (firstRound || delta.size > 0) {
      if (++iterations > maxIterations) {
        throw new EngineLimitError(`derivation exceeded ${maxIterations} iterations`);
      }
      const newDelta: Database = new Map();
      for (const { clause: rule, ruleNumber } of rules) {
        const headKey = litKey(rule.head.predicate, rule.head.args.length);
        const positiveIndexes = rule.body
          .map((goal, i) => (isComparison(goal) || isNegation(goal) ? -1 : i))
          .filter((i) => i >= 0);
        const deltaPositions =
          positiveIndexes.length > 0 ? positiveIndexes : firstRound ? [-1] : [];
        for (const deltaPos of deltaPositions) {
          const source = (goalIndex: number, key: string) =>
            deltaPos >= 0 && goalIndex === deltaPos ? delta.get(key) : db.get(key);
          for (const solution of solveGoals(
            rule.body,
            0,
            {},
            [],
            source,
            stratumOf
          )) {
            const tuple = substituteHead(rule.head, solution.env);
            const entry: FactEntry = {
              predicate: rule.head.predicate,
              tuple,
              derived: true,
              rule: ruleNumber,
              because: solution.proofs.length > 0 ? solution.proofs : undefined,
            };
            if (addTuple(db, headKey, entry)) {
              addTuple(newDelta, headKey, entry);
              if (++totalFacts > maxFacts) {
                throw new EngineLimitError(`derivation exceeded ${maxFacts} facts`);
              }
            }
          }
        }
      }
      delta = newDelta;
      firstRound = false;
    }
  }

  return { db, predicateStrata: stratified.predicateStrata };
}

function queryBindingsWithProofRefs(
  db: Database,
  query: Goal[],
  maxRows: number,
  predicateStrata: Map<string, number>
): QueryRowRef[] {
  const results: QueryRowRef[] = [];
  const seen = new Set<string>();
  const fromDb = (_: number, key: string) => db.get(key);
  const stratumOf = (key: string) => predicateStrata.get(key) ?? 0;

  for (const solution of solveGoals(query, 0, {}, [], fromDb, stratumOf)) {
    const bindings: Bindings = {};
    for (const [name, term] of Object.entries(solution.env)) bindings[name] = term;
    const key = rowKey(bindings);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ bindings, proofs: solution.proofs });
    if (results.length >= maxRows) break;
  }

  return results;
}

function aggregateInputRows(
  db: Database,
  query: Goal[],
  maxAggregateRows: number,
  predicateStrata: Map<string, number>
): QueryRowRef[] {
  if (!Number.isSafeInteger(maxAggregateRows) || maxAggregateRows < 0) {
    throw new EngineSafetyError('maxAggregateRows must be a non-negative safe integer');
  }
  const results: QueryRowRef[] = [];
  const fromDb = (_: number, key: string) => db.get(key);
  const stratumOf = (key: string) => predicateStrata.get(key) ?? 0;
  let inspected = 0;

  for (const solution of solveGoals(query, 0, {}, [], fromDb, stratumOf)) {
    if (++inspected > maxAggregateRows) {
      throw new EngineLimitError(`aggregate input exceeded ${maxAggregateRows} rows`);
    }
    const bindings: Bindings = {};
    for (const [name, term] of Object.entries(solution.env)) bindings[name] = term;
    results.push({ bindings, proofs: solution.proofs });
  }

  return results;
}

interface AggregateResultRef {
  bindings: Bindings;
  value: Term;
  contributors: QueryRowRef[];
  witnessPositions?: number[];
}

function aggregateValue(
  query: AggregateQuerySpec,
  rows: QueryRowRef[]
): AggregateResultRef | null {
  if (query.op === 'count') {
    const value: Term = { type: 'num', value: rows.length };
    return { bindings: { [query.as]: value }, value, contributors: rows };
  }
  if (rows.length === 0) return null;

  const values = rows.map(({ bindings }) => {
    const value = bindings[query.input];
    if (value === undefined || value.type === 'var' || value.type === 'wildcard') {
      throw new EngineSafetyError(
        `aggregate input ${query.input} was not grounded by the query`
      );
    }
    return value;
  });

  let value: Term;
  if (query.op === 'sum') {
    if (values.some((term) => term.type !== 'num')) {
      throw new EngineSafetyError('sum aggregation requires numeric input values');
    }
    const sum = values.reduce((total, term) => total + (term as Term & { type: 'num' }).value, 0);
    if (!Number.isFinite(sum)) {
      throw new EngineSafetyError('sum aggregation produced a non-finite result');
    }
    value = { type: 'num', value: sum };
  } else {
    const type = values[0].type;
    if (values.some((term) => term.type !== type)) {
      throw new EngineSafetyError(`${query.op} aggregation requires one scalar type`);
    }
    value = values[0];
    for (const candidate of values.slice(1)) {
      if (comparisonHolds(query.op === 'min' ? '<' : '>', candidate, value)) {
        value = candidate;
      }
    }
  }

  const witnessPositions =
    query.op === 'min' || query.op === 'max'
      ? values.flatMap((candidate, index) => (termEq(candidate, value) ? [index] : []))
      : undefined;
  return {
    bindings: { [query.as]: value },
    value,
    contributors: rows,
    ...(witnessPositions === undefined ? {} : { witnessPositions }),
  };
}

function serializeAggregateProof(
  query: AggregateQuerySpec,
  result: AggregateResultRef,
  maxProofDepth: number,
  budget: ProofBudget
): AggregateProof {
  if (maxProofDepth < 1) {
    throw new EngineLimitError(`proof exceeded max depth ${maxProofDepth}`);
  }
  if (++budget.emittedNodes > budget.maxNodes) {
    throw new EngineLimitError(`proof exceeded max nodes ${budget.maxNodes}`);
  }
  return {
    aggregated: true,
    op: query.op,
    input: query.input,
    as: query.as,
    value: groundValue(result.value),
    contributors: result.contributors.map(({ bindings, proofs }) => ({
      bindings: { ...bindings },
      proofs: proofs.map((proof) => serializeProof(proof, maxProofDepth, budget, 2)),
    })),
    ...(result.witnessPositions === undefined
      ? {}
      : { witnessPositions: [...result.witnessPositions] }),
  };
}

/**
 * Semi-naive bottom-up evaluation: derive the fixpoint of all rules over the
 * facts, then answer the query conjunction against the resulting database.
 */
export function evaluate(
  clauses: Clause[],
  query: Goal[],
  options: EvaluateOptions = {}
): Bindings[] {
  const { maxRows = 1000 } = options;
  assertGoalsNumericSafety(query);
  const { db, predicateStrata } = deriveDatabase(clauses, options);
  return queryBindingsWithProofRefs(db, query, maxRows, predicateStrata).map(
    ({ bindings }) => bindings
  );
}

export function evaluateWithProof(
  clauses: Clause[],
  query: Goal[],
  options: EvaluateOptions = {}
): ExplainedBindings[] {
  const { maxRows = 1000, maxProofDepth = 128, maxProofNodes = 100_000 } = options;
  assertGoalsNumericSafety(query);
  const { db, predicateStrata } = deriveDatabase(clauses, options);
  const proofBudget: ProofBudget = { maxNodes: maxProofNodes, emittedNodes: 0 };
  return queryBindingsWithProofRefs(db, query, maxRows, predicateStrata).map(
    ({ bindings, proofs }) => ({
      bindings,
      proofs: proofs.map((proof) => serializeProof(proof, maxProofDepth, proofBudget)),
    })
  );
}

/** Evaluate either a relational query or one exact scalar reduction over its full result. */
export function evaluateQuerySpec(
  clauses: Clause[],
  query: QuerySpec,
  options: EvaluateOptions = {}
): Bindings[] {
  if (query.kind === 'relational') return evaluate(clauses, query.goals, options);
  const { maxRows = 1000, maxAggregateRows = 100_000 } = options;
  if (maxRows < 1) return [];
  assertGoalsNumericSafety(query.goals);
  const { db, predicateStrata } = deriveDatabase(clauses, options);
  const rows = aggregateInputRows(db, query.goals, maxAggregateRows, predicateStrata);
  const result = aggregateValue(query, rows);
  return result === null ? [] : [result.bindings];
}

/** Aggregate-aware explanation path; contributors retain their ordered relational proofs. */
export function evaluateQuerySpecWithProof(
  clauses: Clause[],
  query: QuerySpec,
  options: EvaluateOptions = {}
): ExplainedQueryBindings[] {
  if (query.kind === 'relational') return evaluateWithProof(clauses, query.goals, options);
  const {
    maxRows = 1000,
    maxAggregateRows = 100_000,
    maxAggregateProofRows = 256,
    maxProofDepth = 128,
    maxProofNodes = 100_000,
  } = options;
  if (maxRows < 1) return [];
  assertGoalsNumericSafety(query.goals);
  const { db, predicateStrata } = deriveDatabase(clauses, options);
  const rows = aggregateInputRows(db, query.goals, maxAggregateRows, predicateStrata);
  const result = aggregateValue(query, rows);
  if (result === null) return [];
  if (!Number.isSafeInteger(maxAggregateProofRows) || maxAggregateProofRows < 0) {
    throw new EngineSafetyError(
      'maxAggregateProofRows must be a non-negative safe integer'
    );
  }
  if (result.contributors.length > maxAggregateProofRows) {
    throw new EngineLimitError(
      `aggregate proof exceeded ${maxAggregateProofRows} contributor rows`
    );
  }
  const proofBudget: ProofBudget = { maxNodes: maxProofNodes, emittedNodes: 0 };
  return [
    {
      bindings: result.bindings,
      proofs: [serializeAggregateProof(query, result, maxProofDepth, proofBudget)],
    },
  ];
}

export function materializeWithProof(
  clauses: Clause[],
  options: EvaluateOptions = {}
): MaterializedFactWithProof[] {
  const { maxProofDepth = 128, maxProofNodes = 100_000 } = options;
  const { db } = deriveDatabase(clauses, options);
  const facts: MaterializedFactWithProof[] = [];
  const proofBudget: ProofBudget = { maxNodes: maxProofNodes, emittedNodes: 0 };

  for (const relation of db.values()) {
    for (const entry of relation.values()) {
      facts.push({
        predicate: entry.predicate,
        values: entry.tuple.map(groundValue),
        derived: entry.derived,
        proof: serializeProof(entry, maxProofDepth, proofBudget),
      });
    }
  }

  return facts;
}
