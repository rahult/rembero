import {
  type Clause,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  predKey,
} from './ast.js';

export class StratificationError extends Error {
  constructor(message = 'program is not stratifiable: recursion through negation') {
    super(message);
    this.name = 'StratificationError';
  }
}

export interface StratifiedRule {
  clause: Clause;
  ruleNumber: number;
  stratum: number;
}

export interface StratifiedProgram {
  predicateStrata: Map<string, number>;
  strata: StratifiedRule[][];
}

interface Dependency {
  head: string;
  body: string;
  negative: boolean;
}

/**
 * Assign the least stratum satisfying positive H >= B and negative H > B
 * dependencies. A relaxation that still changes after |predicates| passes is
 * exactly a dependency cycle containing at least one negative edge.
 */
export function stratifyProgram(clauses: Clause[]): StratifiedProgram {
  const predicates = new Set<string>();
  const dependencies: Dependency[] = [];
  const rules: Array<{ clause: Clause; ruleNumber: number }> = [];

  let ruleNumber = 0;
  for (const clause of clauses) {
    if (isIntegrityConstraint(clause)) continue;
    const head = predKey(clause.head);
    predicates.add(head);
    if (clause.body.length === 0) continue;
    rules.push({ clause, ruleNumber: ++ruleNumber });
    for (const goal of clause.body) {
      if (isComparison(goal)) continue;
      const literal = isNegation(goal) ? goal.not : goal;
      const body = predKey(literal);
      predicates.add(body);
      dependencies.push({ head, body, negative: isNegation(goal) });
    }
  }

  const predicateStrata = new Map([...predicates].map((key) => [key, 0]));
  for (let pass = 0; pass < predicates.size; pass++) {
    let changed = false;
    for (const dependency of dependencies) {
      const required =
        (predicateStrata.get(dependency.body) ?? 0) + (dependency.negative ? 1 : 0);
      if ((predicateStrata.get(dependency.head) ?? 0) < required) {
        predicateStrata.set(dependency.head, required);
        changed = true;
      }
    }
    if (!changed) break;
    if (pass === predicates.size - 1) throw new StratificationError();
  }

  const highest = Math.max(0, ...predicateStrata.values());
  const strata: StratifiedRule[][] = Array.from({ length: highest + 1 }, () => []);
  for (const rule of rules) {
    const stratum = predicateStrata.get(predKey(rule.clause.head)) ?? 0;
    strata[stratum].push({ ...rule, stratum });
  }
  return { predicateStrata, strata };
}
