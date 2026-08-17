export type Term =
  | { type: 'atom'; value: string }
  | { type: 'num'; value: number }
  | { type: 'var'; name: string }
  | { type: 'wildcard' };

export type ArithmeticOp = '+' | '-' | '*' | '/';
export type UnaryArithmeticOp = '+' | '-';

export interface UnaryArithmeticExpression {
  kind: 'unary';
  op: UnaryArithmeticOp;
  operand: ScalarExpression;
}

export interface BinaryArithmeticExpression {
  kind: 'binary';
  op: ArithmeticOp;
  left: ScalarExpression;
  right: ScalarExpression;
}

/** Arithmetic expression operands are deliberately confined to comparison filters. */
export type ScalarExpression =
  | Term
  | UnaryArithmeticExpression
  | BinaryArithmeticExpression;

export const MAX_ARITHMETIC_EXPRESSION_DEPTH = 64;
export const MAX_ARITHMETIC_EXPRESSION_NODES = 256;

export type CmpOp = '=' | '!=' | '<' | '>' | '<=' | '>=';

export interface Literal {
  predicate: string;
  args: Term[];
}

export interface Comparison {
  op: CmpOp;
  left: ScalarExpression;
  right: ScalarExpression;
}

export interface Negation {
  not: Literal;
}

export type Goal = Literal | Comparison | Negation;

export interface OrdinaryClause {
  head: Literal;
  body: Goal[];
  integrity?: false;
  aggregate?: undefined;
}

export interface AggregateRuleSpec {
  op: AggregateOperator;
  input: '*' | string;
  as: string;
}

export interface AggregateRuleClause {
  head: Literal;
  body: Goal[];
  aggregate: AggregateRuleSpec;
  integrity?: false;
}

export interface IntegrityConstraintClause {
  head: Literal;
  body: Goal[];
  integrity: true;
  aggregate?: undefined;
}

export type Clause = OrdinaryClause | AggregateRuleClause | IntegrityConstraintClause;

export type AggregateOperator = 'count' | 'sum' | 'min' | 'max';

export interface RelationalQuerySpec {
  kind: 'relational';
  goals: Goal[];
}

export interface AggregateQuerySpec {
  kind: 'aggregate';
  op: AggregateOperator;
  /** Count consumes complete result rows; other operators name a bound input variable. */
  input: '*' | string;
  /** Fresh output variable receiving the scalar result. */
  as: string;
  goals: Goal[];
}

export type QuerySpec = RelationalQuerySpec | AggregateQuerySpec;

export function isComparison(goal: Goal): goal is Comparison {
  return 'op' in goal;
}

export function isArithmeticExpression(
  expression: ScalarExpression
): expression is UnaryArithmeticExpression | BinaryArithmeticExpression {
  return 'kind' in expression;
}

export function isNegation(goal: Goal): goal is Negation {
  return 'not' in goal;
}

export function isIntegrityConstraint(
  clause: Clause
): clause is IntegrityConstraintClause {
  return clause.integrity === true;
}

export function isAggregateRule(clause: Clause): clause is AggregateRuleClause {
  return clause.aggregate !== undefined;
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
      if (!Number.isFinite(term.value)) {
        throw new Error('numeric terms must be finite');
      }
      return String(term.value);
    case 'var':
      return term.name;
    case 'wildcard':
      return '_';
  }
}

interface RenderedExpression {
  text: string;
  precedence: number;
  unary: boolean;
}

function arithmeticPrecedence(op: ArithmeticOp): number {
  return op === '*' || op === '/' ? 2 : 1;
}

function renderScalarExpression(expression: ScalarExpression): RenderedExpression {
  if (!isArithmeticExpression(expression)) {
    return { text: serializeTerm(expression), precedence: 4, unary: false };
  }
  if (expression.kind === 'unary') {
    const operand = renderScalarExpression(expression.operand);
    const needsParentheses =
      operand.precedence < 3 ||
      operand.unary ||
      (!isArithmeticExpression(expression.operand) &&
        expression.operand.type === 'num' &&
        expression.operand.value < 0);
    return {
      text: `${expression.op}${needsParentheses ? `(${operand.text})` : operand.text}`,
      precedence: 3,
      unary: true,
    };
  }

  const precedence = arithmeticPrecedence(expression.op);
  const left = renderScalarExpression(expression.left);
  const right = renderScalarExpression(expression.right);
  const leftText = left.precedence < precedence ? `(${left.text})` : left.text;
  // Arithmetic is evaluated exactly in AST order. Preserve right-nested operations,
  // including mathematically associative ones whose IEEE-754 rounding may differ.
  const rightText =
    right.precedence < precedence || right.precedence === precedence
      ? `(${right.text})`
      : right.text;
  return {
    text: `${leftText} ${expression.op} ${rightText}`,
    precedence,
    unary: false,
  };
}

export function serializeScalarExpression(expression: ScalarExpression): string {
  return renderScalarExpression(expression).text;
}

export function serializeGoal(goal: Goal): string {
  if (isComparison(goal)) {
    return `${serializeScalarExpression(goal.left)} ${goal.op} ${serializeScalarExpression(goal.right)}`;
  }
  if (isNegation(goal)) return `\\+ ${serializeGoal(goal.not)}`;
  if (goal.args.length === 0) return goal.predicate;
  return `${goal.predicate}(${goal.args.map(serializeTerm).join(', ')})`;
}

export function serializeClause(clause: Clause): string {
  if (isIntegrityConstraint(clause)) {
    return `:- ${clause.body.map(serializeGoal).join(', ')}.`;
  }
  const head = serializeGoal(clause.head);
  if (clause.body.length === 0) return `${head}.`;
  if (isAggregateRule(clause)) {
    const goals = clause.body.map(serializeGoal).join(', ');
    return `${head} :- ${clause.aggregate.op}(${clause.aggregate.input}) as ${clause.aggregate.as} where ${goals}.`;
  }
  return `${head} :- ${clause.body.map(serializeGoal).join(', ')}.`;
}

export function serializeQuerySpec(query: QuerySpec): string {
  const goals = query.goals.map(serializeGoal).join(', ');
  if (query.kind === 'relational') return goals;
  return `${query.op}(${query.input}) as ${query.as} where ${goals}`;
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
  const renameExpression = (expression: ScalarExpression): ScalarExpression => {
    if (!isArithmeticExpression(expression)) return rename(expression);
    if (expression.kind === 'unary') {
      return {
        kind: 'unary',
        op: expression.op,
        operand: renameExpression(expression.operand),
      };
    }
    return {
      kind: 'binary',
      op: expression.op,
      left: renameExpression(expression.left),
      right: renameExpression(expression.right),
    };
  };
  const renameGoal = (goal: Goal): Goal =>
    isComparison(goal)
      ? {
          op: goal.op,
          left: renameExpression(goal.left),
          right: renameExpression(goal.right),
        }
      : isNegation(goal)
        ? { not: { predicate: goal.not.predicate, args: goal.not.args.map(rename) } }
        : { predicate: goal.predicate, args: goal.args.map(rename) };
  if (isIntegrityConstraint(clause)) {
    return serializeClause({
      head: clause.head,
      body: clause.body.map(renameGoal),
      integrity: true,
    });
  }
  const head = renameGoal(clause.head) as Literal;
  const body = clause.body.map(renameGoal);
  if (isAggregateRule(clause)) {
    const renameVariable = (name: string): string =>
      (rename({ type: 'var', name }) as Extract<Term, { type: 'var' }>).name;
    return serializeClause({
      head,
      body,
      aggregate: {
        op: clause.aggregate.op,
        input:
          clause.aggregate.input === '*'
            ? '*'
            : renameVariable(clause.aggregate.input),
        as: renameVariable(clause.aggregate.as),
      },
    });
  }
  return serializeClause({ head, body });
}
