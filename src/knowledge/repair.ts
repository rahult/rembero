import { createHash } from 'node:crypto';
import {
  type Literal,
  EngineLimitError,
  EngineSafetyError,
  isComparison,
  isNegation,
  parseQuery,
  serializeGoal,
} from '../engine/index.js';
import type { MemoryStore } from '../store/store.js';
import {
  applyCounterfactualChanges,
  captureCounterfactualBaseline,
  evaluateCounterfactualKnowledgeView,
  type CounterfactualApplication,
  type CounterfactualBaseline,
  type CounterfactualIntegrityDelta,
  type CounterfactualKnowledgeResult,
  type CounterfactualResultDelta,
} from './counterfactual.js';
import {
  explainKnowledge,
  type ExplainKnowledgeResult,
} from './graph.js';
import type { EntityIdentityMode } from './identity.js';
import type { TrustViewMode } from './trust.js';
import {
  explainWhyNot,
  type ExplainWhyNotResult,
  type WhyNotFailure,
} from './why-not.js';

export const DEFAULT_MAX_REPAIR_PLANS = 8;
export const MAX_REPAIR_PLANS = 32;
export const DEFAULT_MAX_REPAIR_STEPS = 4;
export const MAX_REPAIR_STEPS = 8;
export const DEFAULT_MAX_REPAIR_SEARCH_STATES = 128;
export const MAX_REPAIR_SEARCH_STATES = 512;

export type RepairPlanStatus = 'already_satisfied' | 'repairable' | 'unresolved';

export interface RepairPlanOptions {
  namespace?: string;
  namespaces?: string[] | '*';
  entityIdentity?: EntityIdentityMode;
  trustMode?: TrustViewMode;
  maxProofsPerRow?: number;
  maxViolations?: number;
  maxPlans?: number;
  maxSteps?: number;
  maxSearchStates?: number;
}

export interface VerifiedRepairPlan {
  id: string;
  assume: string[];
  without: string[];
  changeCount: number;
  searchDepth: number;
  strictIntegritySafe: boolean;
  noNewViolationsSafe: boolean;
  application: CounterfactualApplication;
  candidate: ExplainKnowledgeResult;
  resultDelta: CounterfactualResultDelta;
  integrityDelta: CounterfactualIntegrityDelta;
}

export interface RepairPlanResult {
  status: RepairPlanStatus;
  query: string;
  namespace: string;
  namespaces: string[];
  baselineDigest: string;
  baseline: ExplainWhyNotResult;
  plans: VerifiedRepairPlan[];
  searchedStates: number;
  trustMode?: TrustViewMode;
}

interface PlanState {
  assume: string[];
  without: string[];
  depth: number;
}

interface RepairEdit {
  assume: string[];
  without: string[];
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new EngineSafetyError(`${label} must be from 1 to ${maximum}`);
  }
  return resolved;
}

function stateKey(state: Pick<PlanState, 'assume' | 'without'>): string {
  return JSON.stringify([
    [...state.assume].sort(),
    [...state.without].sort(),
  ]);
}

function baselineDigest(baseline: CounterfactualBaseline): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        namespaces: baseline.namespaces,
        clauses: baseline.clausesByNamespace.size === 0
          ? []
          : baseline.namespaces.map((namespace) => [
              namespace,
              (baseline.clausesByNamespace.get(namespace) ?? []).map((clause) =>
                JSON.stringify(clause)
              ),
            ]),
        sources: [...baseline.sources],
      })
    )
    .digest('hex');
}

function groundPositiveFact(goal: string): string | undefined {
  let goals;
  try {
    goals = parseQuery(goal);
  } catch {
    return undefined;
  }
  if (goals.length !== 1 || isComparison(goals[0]) || isNegation(goals[0])) {
    return undefined;
  }
  const literal = goals[0] as Literal;
  if (
    literal.args.some((term) => term.type !== 'atom' && term.type !== 'num')
  ) {
    return undefined;
  }
  return `${serializeGoal(literal)}.`;
}

function exactRetraction(fact: string): string {
  return fact.endsWith('.') ? fact.slice(0, -1) : fact;
}

function projectedFacts(value: unknown, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) projectedFacts(item, result);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.projectedFrom === 'string') {
    const normalized = groundPositiveFact(exactRetraction(record.projectedFrom));
    if (normalized !== undefined) result.add(normalized);
  }
  for (const nested of Object.values(record)) projectedFacts(nested, result);
}

function retractionFacts(failure: WhyNotFailure): string[] {
  const facts = new Set<string>();
  for (const observed of failure.nearby) {
    facts.add(observed.fact);
    projectedFacts(observed.explanation, facts);
  }
  return [...facts];
}

function targetFactKeys(baseline: CounterfactualBaseline): Set<string> {
  return new Set(
    (baseline.clausesByNamespace.get(baseline.namespace) ?? [])
      .filter((clause) => clause.body.length === 0)
      .map((clause) => `${serializeGoal(clause.head)}.`)
  );
}

function editsForFailure(
  failure: WhyNotFailure,
  retractableFacts: ReadonlySet<string>
): RepairEdit[] {
  if (failure.reason === 'missing_fact') {
    const fact = groundPositiveFact(failure.goal);
    return fact === undefined ? [] : [{ assume: [fact], without: [] }];
  }
  if (failure.reason === 'negated_fact_present') {
    const facts = retractionFacts(failure).filter((fact) =>
      retractableFacts.has(fact)
    );
    return facts.length === 0
      ? []
      : [{ assume: [], without: facts.map(exactRetraction).sort() }];
  }
  if (failure.reason !== 'rules_blocked') return [];
  return failure.rules.flatMap((rule) =>
    rule.failures.flatMap((nested) => editsForFailure(nested, retractableFacts))
  );
}

function candidateEdits(
  whyNot: ExplainWhyNotResult,
  baseline: CounterfactualBaseline
): RepairEdit[] {
  const retractable = targetFactKeys(baseline);
  const byKey = new Map<string, RepairEdit>();
  for (const failure of whyNot.failures) {
    for (const edit of editsForFailure(failure, retractable)) {
      const normalized = {
        assume: [...new Set(edit.assume)].sort(),
        without: [...new Set(edit.without)].sort(),
      };
      byKey.set(stateKey(normalized), normalized);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    stateKey(left).localeCompare(stateKey(right))
  );
}

function mergeState(state: PlanState, edit: RepairEdit): PlanState {
  return {
    assume: [...new Set([...state.assume, ...edit.assume])].sort(),
    without: [...new Set([...state.without, ...edit.without])].sort(),
    depth: state.depth + 1,
  };
}

function stateCost(state: Pick<PlanState, 'assume' | 'without'>): number {
  return state.assume.length + state.without.length;
}

function viewFor(baseline: CounterfactualBaseline, state: PlanState) {
  return applyCounterfactualChanges(baseline, {
    assume: state.assume.join('\n'),
    without: state.without,
  });
}

function explanationOptions(options: RepairPlanOptions) {
  return {
    ...(options.entityIdentity === undefined
      ? {}
      : { entityIdentity: options.entityIdentity }),
    ...(options.trustMode === undefined || options.trustMode === 'accepted'
      ? {}
      : { trustMode: options.trustMode }),
    ...(options.maxProofsPerRow === undefined
      ? {}
      : { maxProofsPerRow: options.maxProofsPerRow }),
  };
}

function diagnoseState(
  baseline: CounterfactualBaseline,
  state: PlanState,
  query: string,
  options: RepairPlanOptions
): ExplainWhyNotResult {
  const view = viewFor(baseline, state);
  return explainWhyNot(
    view.candidateClauses,
    query,
    view.candidateSources,
    explanationOptions(options)
  );
}

function satisfies(
  baseline: CounterfactualBaseline,
  state: PlanState,
  query: string,
  options: RepairPlanOptions
): boolean {
  const view = viewFor(baseline, state);
  return explainKnowledge(
    view.candidateClauses,
    query,
    view.candidateSources,
    explanationOptions(options)
  ).rows.length > 0;
}

function minimizeState(
  baseline: CounterfactualBaseline,
  state: PlanState,
  query: string,
  options: RepairPlanOptions
): PlanState {
  let current = state;
  let changed = true;
  while (changed) {
    changed = false;
    const candidates: PlanState[] = [
      ...current.assume.map((_value, index) => ({
        ...current,
        assume: current.assume.filter((_candidate, position) => position !== index),
      })),
      ...current.without.map((_value, index) => ({
        ...current,
        without: current.without.filter((_candidate, position) => position !== index),
      })),
    ];
    for (const candidate of candidates) {
      if (satisfies(baseline, candidate, query, options)) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

function verifiedPlan(
  baseline: CounterfactualBaseline,
  state: PlanState,
  query: string,
  options: RepairPlanOptions
): VerifiedRepairPlan {
  const view = viewFor(baseline, state);
  const simulation: CounterfactualKnowledgeResult =
    evaluateCounterfactualKnowledgeView(view, query, {
      ...explanationOptions(options),
      ...(options.maxViolations === undefined
        ? {}
        : { maxViolations: options.maxViolations }),
    });
  if (simulation.candidate.rows.length === 0) {
    throw new Error('repair verification did not satisfy the requested query');
  }
  const id = `repair:${createHash('sha256')
    .update(stateKey(state))
    .digest('hex')}`;
  return {
    id,
    assume: [...state.assume],
    without: [...state.without],
    changeCount: state.assume.length + state.without.length,
    searchDepth: state.depth,
    strictIntegritySafe:
      simulation.integrityDelta.candidate.violationCount === 0,
    noNewViolationsSafe:
      simulation.integrityDelta.introduced.length === 0,
    application: simulation.application,
    candidate: simulation.candidate,
    resultDelta: simulation.resultDelta,
    integrityDelta: simulation.integrityDelta,
  };
}

function editSet(plan: VerifiedRepairPlan): Set<string> {
  return new Set([
    ...plan.assume.map((fact) => `assume:${fact}`),
    ...plan.without.map((fact) => `without:${fact}`),
  ]);
}

function properSubset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size < right.size && [...left].every((value) => right.has(value));
}

/** Search for minimal grounded fact changes that are proven to satisfy one query. */
export function planKnowledgeRepair(
  store: MemoryStore,
  query: string,
  options: RepairPlanOptions = {}
): RepairPlanResult {
  const maxPlans = boundedOption(
    options.maxPlans,
    DEFAULT_MAX_REPAIR_PLANS,
    MAX_REPAIR_PLANS,
    'maxPlans'
  );
  const maxSteps = boundedOption(
    options.maxSteps,
    DEFAULT_MAX_REPAIR_STEPS,
    MAX_REPAIR_STEPS,
    'maxSteps'
  );
  const maxSearchStates = boundedOption(
    options.maxSearchStates,
    DEFAULT_MAX_REPAIR_SEARCH_STATES,
    MAX_REPAIR_SEARCH_STATES,
    'maxSearchStates'
  );
  const baseline = captureCounterfactualBaseline(store, {
    namespace: options.namespace,
    namespaces: options.namespaces,
  });
  const initial = explainWhyNot(
    baseline.clauses,
    query,
    baseline.sources,
    explanationOptions(options)
  );
  const common = {
    query,
    namespace: baseline.namespace,
    namespaces: [...baseline.namespaces],
    baselineDigest: baselineDigest(baseline),
    baseline: initial,
    ...(options.trustMode === undefined || options.trustMode === 'accepted'
      ? {}
      : { trustMode: options.trustMode }),
  };
  if (initial.status === 'satisfied') {
    return {
      status: 'already_satisfied',
      ...common,
      plans: [],
      searchedStates: 1,
    };
  }

  const queue: Array<{ state: PlanState; whyNot: ExplainWhyNotResult }> = [
    { state: { assume: [], without: [], depth: 0 }, whyNot: initial },
  ];
  const visitedDepth = new Map<string, number>([[stateKey(queue[0].state), 0]]);
  const satisfied: PlanState[] = [];
  let searchedStates = 1;
  let bestCost = Number.POSITIVE_INFINITY;
  let minimumDepthBlockedCost = Number.POSITIVE_INFINITY;
  while (queue.length > 0) {
    queue.sort(
      (left, right) =>
        stateCost(left.state) - stateCost(right.state) ||
        left.state.depth - right.state.depth ||
        stateKey(left.state).localeCompare(stateKey(right.state))
    );
    const { state, whyNot } = queue.shift()!;
    if (stateCost(state) >= bestCost) continue;
    const edits = candidateEdits(whyNot, baseline);
    if (state.depth >= maxSteps) {
      for (const edit of edits) {
        minimumDepthBlockedCost = Math.min(
          minimumDepthBlockedCost,
          stateCost(mergeState(state, edit))
        );
      }
      continue;
    }
    for (const edit of edits) {
      const next = mergeState(state, edit);
      const key = stateKey(next);
      if (key === stateKey(state)) continue;
      const priorDepth = visitedDepth.get(key);
      if (priorDepth !== undefined && priorDepth <= next.depth) continue;
      visitedDepth.set(key, next.depth);
      if (++searchedStates > maxSearchStates) {
        throw new EngineLimitError(
          `repair search exceeded ${maxSearchStates} states`
        );
      }
      const diagnosis = diagnoseState(baseline, next, query, options);
      if (diagnosis.status === 'satisfied') {
        const cost = stateCost(next);
        if (cost < bestCost) {
          bestCost = cost;
          satisfied.length = 0;
        }
        satisfied.push(next);
      } else if (stateCost(next) < bestCost && next.depth < maxSteps) {
        queue.push({ state: next, whyNot: diagnosis });
      } else if (candidateEdits(diagnosis, baseline).length > 0) {
        for (const nextEdit of candidateEdits(diagnosis, baseline)) {
          minimumDepthBlockedCost = Math.min(
            minimumDepthBlockedCost,
            stateCost(mergeState(next, nextEdit))
          );
        }
      }
    }
  }
  if (
    Number.isFinite(minimumDepthBlockedCost) &&
    minimumDepthBlockedCost <= bestCost
  ) {
    throw new EngineLimitError(`repair search exceeded depth ${maxSteps}`);
  }
  const minimizedByKey = new Map<string, PlanState>();
  for (const state of satisfied) {
    const minimized = minimizeState(baseline, state, query, options);
    minimizedByKey.set(stateKey(minimized), minimized);
  }
  let plans = [...minimizedByKey.values()].map((state) =>
    verifiedPlan(baseline, state, query, options)
  );
  const minimumChangeCount = Math.min(
    Number.POSITIVE_INFINITY,
    ...plans.map(({ changeCount }) => changeCount)
  );
  plans = plans.filter(({ changeCount }) => changeCount === minimumChangeCount);
  plans = plans.filter((plan, index) => {
    const values = editSet(plan);
    return !plans.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index && properSubset(editSet(candidate), values)
    );
  });
  plans.sort(
    (left, right) =>
      left.changeCount - right.changeCount || left.id.localeCompare(right.id)
  );
  if (plans.length > maxPlans) {
    throw new EngineLimitError(`repair search exceeded ${maxPlans} plans`);
  }
  return {
    status: plans.length > 0 ? 'repairable' : 'unresolved',
    ...common,
    plans,
    searchedStates,
  };
}
