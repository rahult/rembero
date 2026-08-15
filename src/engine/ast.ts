export type Term =
  | { type: 'atom'; value: string }
  | { type: 'num'; value: number }
  | { type: 'var'; name: string }
  | { type: 'wildcard' };

export type CmpOp = '=' | '!=' | '<' | '>' | '<=' | '>=';

export interface Literal {
  predicate: string;
  args: Term[];
}

export interface Comparison {
  op: CmpOp;
  left: Term;
  right: Term;
}

export type Goal = Literal | Comparison;

export interface Clause {
  head: Literal;
  body: Goal[];
}

export function isComparison(goal: Goal): goal is Comparison {
  return 'op' in goal;
}

export function predKey(lit: Literal): string {
  return `${lit.predicate}/${lit.args.length}`;
}

const BARE_ATOM = /^[a-z][a-zA-Z0-9_]*$/;

export function serializeTerm(term: Term): string {
  switch (term.type) {
    case 'atom':
      return BARE_ATOM.test(term.value) ? term.value : `'${term.value.replace(/'/g, "''")}'`;
    case 'num':
      return String(term.value);
    case 'var':
      return term.name;
    case 'wildcard':
      return '_';
  }
}

export function serializeGoal(goal: Goal): string {
  if (isComparison(goal)) {
    return `${serializeTerm(goal.left)} ${goal.op} ${serializeTerm(goal.right)}`;
  }
  if (goal.args.length === 0) return goal.predicate;
  return `${goal.predicate}(${goal.args.map(serializeTerm).join(', ')})`;
}

export function serializeClause(clause: Clause): string {
  const head = serializeGoal(clause.head);
  if (clause.body.length === 0) return `${head}.`;
  return `${head} :- ${clause.body.map(serializeGoal).join(', ')}.`;
}

/**
 * Dedup key: variables renamed V0, V1, ... in order of first appearance, so
 * alpha-equivalent rules (colleague(A,B) vs colleague(X,Y)) collapse to one key.
 */
export function canonicalKey(clause: Clause): string {
  const mapping = new Map<string, string>();
  const rename = (term: Term): Term => {
    if (term.type !== 'var') return term;
    let name = mapping.get(term.name);
    if (name === undefined) {
      name = `V${mapping.size}`;
      mapping.set(term.name, name);
    }
    return { type: 'var', name };
  };
  const renameGoal = (goal: Goal): Goal =>
    isComparison(goal)
      ? { op: goal.op, left: rename(goal.left), right: rename(goal.right) }
      : { predicate: goal.predicate, args: goal.args.map(rename) };
  return serializeClause({
    head: renameGoal(clause.head) as Literal,
    body: clause.body.map(renameGoal),
  });
}
