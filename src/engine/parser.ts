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
import { ParseError, type Token, tokenize } from './lexer.js';
import { stratifyProgram } from './stratify.js';

class TokenStream {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  next(): Token {
    const token = this.peek();
    if (token.kind !== 'eof') this.pos++;
    return token;
  }

  expect(kind: Token['kind']): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new ParseError(`expected '${kind}' but found '${token.text}'`, token.line);
    }
    return this.next();
  }
}

function parseTerm(ts: TokenStream): Term {
  const token = ts.next();
  switch (token.kind) {
    case 'atom':
    case 'qatom':
      return { type: 'atom', value: token.text };
    case 'num':
      return { type: 'num', value: token.num! };
    case 'var':
      return { type: 'var', name: token.text };
    case 'wildcard':
      return { type: 'wildcard' };
    default:
      throw new ParseError(`expected a term but found '${token.text}'`, token.line);
  }
}

function parseLiteral(ts: TokenStream): Literal {
  const name = ts.expect('atom');
  const args: Term[] = [];
  if (ts.peek().kind === '(') {
    ts.next();
    args.push(parseTerm(ts));
    while (ts.peek().kind === ',') {
      ts.next();
      args.push(parseTerm(ts));
    }
    ts.expect(')');
  }
  return { predicate: name.text, args };
}

function parseGoal(ts: TokenStream): Goal {
  if (ts.peek().kind === 'not') {
    ts.next();
    return { not: parseLiteral(ts) };
  }
  // A goal starting with a bare atom + '(' or standing alone is a literal;
  // anything followed by a comparison operator is a comparison.
  const start = ts.peek();
  if (start.kind === 'atom' && ts.peek(1).kind !== 'cmp') {
    return parseLiteral(ts);
  }
  const left = parseTerm(ts);
  const opToken = ts.expect('cmp');
  const right = parseTerm(ts);
  return { op: opToken.text as CmpOp, left, right };
}

function goalVars(goal: Goal): string[] {
  const terms = isComparison(goal)
    ? [goal.left, goal.right]
    : isNegation(goal)
      ? goal.not.args
      : goal.args;
  return terms.filter((t): t is Term & { type: 'var' } => t.type === 'var').map((t) => t.name);
}

function checkClause(clause: Clause, line: number): void {
  if (clause.body.length === 0) {
    const vars = goalVars(clause.head);
    if (vars.length > 0 || clause.head.args.some((a) => a.type === 'wildcard')) {
      throw new ParseError(
        `facts must be ground: '${clause.head.predicate}' contains variable ${vars[0] ?? '_'}`,
        line
      );
    }
    return;
  }
  const bound = new Set<string>();
  for (const goal of clause.body) {
    if (!isComparison(goal) && !isNegation(goal)) {
      for (const name of goalVars(goal)) bound.add(name);
      continue;
    }
    for (const name of goalVars(goal)) {
      if (!bound.has(name)) {
        throw new ParseError(
          `range restriction violated: variable ${name} must be bound by an earlier positive body relation`,
          line
        );
      }
    }
  }
  for (const name of goalVars(clause.head)) {
    if (!bound.has(name)) {
      throw new ParseError(
        `range restriction violated: variable ${name} does not appear in any positive body relation`,
        line
      );
    }
  }
  const headWild = clause.head.args.some((a) => a.type === 'wildcard');
  if (headWild) {
    throw new ParseError('rule heads may not contain wildcards', line);
  }
}

function checkQuery(goals: Goal[]): void {
  const bound = new Set<string>();
  for (const goal of goals) {
    if (!isComparison(goal) && !isNegation(goal)) {
      for (const name of goalVars(goal)) bound.add(name);
      continue;
    }
    for (const name of goalVars(goal)) {
      if (!bound.has(name)) {
        throw new ParseError(
          `range restriction violated: variable ${name} must be bound by an earlier positive query relation`
        );
      }
    }
  }
}

export function parseProgram(input: string): Clause[] {
  const ts = new TokenStream(tokenize(input));
  const clauses: Clause[] = [];
  while (ts.peek().kind !== 'eof') {
    const line = ts.peek().line;
    const head = parseLiteral(ts);
    const body: Goal[] = [];
    if (ts.peek().kind === ':-') {
      ts.next();
      body.push(parseGoal(ts));
      while (ts.peek().kind === ',') {
        ts.next();
        body.push(parseGoal(ts));
      }
    }
    ts.expect('.');
    const clause = { head, body };
    checkClause(clause, line);
    clauses.push(clause);
  }
  stratifyProgram(clauses);
  return clauses;
}

export function parseQuery(input: string): Goal[] {
  const ts = new TokenStream(tokenize(input));
  if (ts.peek().kind === '?-') ts.next();
  if (ts.peek().kind === 'eof') {
    throw new ParseError('empty query');
  }
  const goals: Goal[] = [parseGoal(ts)];
  while (ts.peek().kind === ',') {
    ts.next();
    goals.push(parseGoal(ts));
  }
  if (ts.peek().kind === '.') ts.next();
  const trailing = ts.peek();
  if (trailing.kind !== 'eof') {
    throw new ParseError(`unexpected '${trailing.text}' after query`, trailing.line);
  }
  checkQuery(goals);
  return goals;
}
