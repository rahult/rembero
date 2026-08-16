import {
  type Clause,
  type CmpOp,
  type Comparison,
  type Goal,
  type Literal,
  type Term,
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

export interface ExplainedBindings {
  bindings: Bindings;
  proofs: ProofStep[];
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

function termEq(a: Term, b: Term): boolean {
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
  const left = resolve(goal.left, env);
  const right = resolve(goal.right, env);
  if (left.type === 'var' || left.type === 'wildcard') return false;
  if (right.type === 'var' || right.type === 'wildcard') return false;
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
  if (term.type === 'num') return term.value;
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
): Array<{ bindings: Bindings; proofs: ProofRef[] }> {
  const results: Array<{ bindings: Bindings; proofs: ProofRef[] }> = [];
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
  const { db, predicateStrata } = deriveDatabase(clauses, options);
  const proofBudget: ProofBudget = { maxNodes: maxProofNodes, emittedNodes: 0 };
  return queryBindingsWithProofRefs(db, query, maxRows, predicateStrata).map(
    ({ bindings, proofs }) => ({
      bindings,
      proofs: proofs.map((proof) => serializeProof(proof, maxProofDepth, proofBudget)),
    })
  );
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
