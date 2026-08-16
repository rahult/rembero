import { describe, it, expect } from 'vitest';
import {
  parseProgram,
  parseQuery,
  parseQuerySpec,
  canonicalKey,
  serializeClause,
  serializeQuerySpec,
  ParseError,
  StratificationError,
} from '../src/engine/index.js';

describe('parseProgram', () => {
  it('parses a simple fact', () => {
    const clauses = parseProgram('works_at(rahul, acme).');
    expect(clauses).toHaveLength(1);
    expect(clauses[0].head).toEqual({
      predicate: 'works_at',
      args: [
        { type: 'atom', value: 'rahul' },
        { type: 'atom', value: 'acme' },
      ],
    });
    expect(clauses[0].body).toEqual([]);
  });

  it('parses quoted atoms with spaces and escaped quotes', () => {
    const clauses = parseProgram("company(acme, 'Acme Corp Pty Ltd').");
    expect(clauses[0].head.args[1]).toEqual({ type: 'atom', value: 'Acme Corp Pty Ltd' });
    const escaped = parseProgram("note(a, 'it''s fine').");
    expect(escaped[0].head.args[1]).toEqual({ type: 'atom', value: "it's fine" });
  });

  it('parses numbers, including negatives and decimals', () => {
    const clauses = parseProgram('age(rahul, 38). temp(sydney, -1.5).');
    expect(clauses[0].head.args[1]).toEqual({ type: 'num', value: 38 });
    expect(clauses[1].head.args[1]).toEqual({ type: 'num', value: -1.5 });
  });

  it('rejects non-finite numeric literals', () => {
    expect(() => parseProgram(`value(${'9'.repeat(309)}).`)).toThrow(/out of range/i);
  });

  it('parses a rule with variables and a comparison', () => {
    const clauses = parseProgram(
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'
    );
    expect(clauses).toHaveLength(1);
    const rule = clauses[0];
    expect(rule.head.predicate).toBe('colleague');
    expect(rule.head.args).toEqual([
      { type: 'var', name: 'X' },
      { type: 'var', name: 'Y' },
    ]);
    expect(rule.body).toHaveLength(3);
    expect(rule.body[2]).toEqual({
      op: '!=',
      left: { type: 'var', name: 'X' },
      right: { type: 'var', name: 'Y' },
    });
  });

  it('skips % comments and blank lines', () => {
    const clauses = parseProgram(`
      % people
      person(rahul).

      person(maya). % inline comment
    `);
    expect(clauses).toHaveLength(2);
  });

  it('parses zero-arity facts', () => {
    const clauses = parseProgram('system_initialized.');
    expect(clauses[0].head).toEqual({ predicate: 'system_initialized', args: [] });
  });

  it('rejects a fact containing variables (facts must be ground)', () => {
    expect(() => parseProgram('works_at(X, acme).')).toThrow(ParseError);
  });

  it('rejects a rule whose head variable is not bound in the body (range restriction)', () => {
    expect(() => parseProgram('knows(X, Z) :- person(X).')).toThrow(/range/i);
  });

  it('rejects a comparison over variables not bound by a positive literal', () => {
    expect(() => parseProgram('adult(X) :- person(X), Y > 18.')).toThrow(/range/i);
  });

  it('parses and serializes stratified negation', () => {
    const [rule] = parseProgram(
      'available(X) :- employee(X), \\+ suspended(X), \\+ desk(X, _).'
    );
    expect(rule.body[1]).toEqual({
      not: {
        predicate: 'suspended',
        args: [{ type: 'var', name: 'X' }],
      },
    });
    expect(serializeClause(rule)).toBe(
      'available(X) :- employee(X), \\+ suspended(X), \\+ desk(X, _).'
    );
  });

  it('requires negation and comparisons to use earlier positive bindings', () => {
    expect(() => parseProgram('available(X) :- \\+ suspended(X), employee(X).')).toThrow(
      /earlier positive/i
    );
    expect(() => parseProgram('adult(X) :- A >= 18, age(X, A).')).toThrow(
      /earlier positive/i
    );
    expect(() =>
      parseProgram('ahead(X) :- metric(X, A), A > Missing + 5.')
    ).toThrow(/earlier positive/i);
  });

  it('parses bounded arithmetic expressions in comparison filters', () => {
    const [rule] = parseProgram(
      'ahead(X) :- metric(X, A), baseline(X, B), A + B * 2 > -(B - 3).'
    );
    expect(rule.body[2]).toEqual({
      op: '>',
      left: {
        kind: 'binary',
        op: '+',
        left: { type: 'var', name: 'A' },
        right: {
          kind: 'binary',
          op: '*',
          left: { type: 'var', name: 'B' },
          right: { type: 'num', value: 2 },
        },
      },
      right: {
        kind: 'unary',
        op: '-',
        operand: {
          kind: 'binary',
          op: '-',
          left: { type: 'var', name: 'B' },
          right: { type: 'num', value: 3 },
        },
      },
    });
    expect(serializeClause(rule)).toBe(
      'ahead(X) :- metric(X, A), baseline(X, B), A + B * 2 > -(B - 3).'
    );
  });

  it('preserves arithmetic grouping and left associativity when serializing', () => {
    const [grouped] = parseProgram(
      'selected(X) :- metric(X, A), limit(X, B), (A + B) * 2 >= A - (B - 1).'
    );
    const serialized = serializeClause(grouped);
    expect(serialized).toBe(
      'selected(X) :- metric(X, A), limit(X, B), (A + B) * 2 >= A - (B - 1).'
    );
    expect(serializeClause(parseProgram(serialized)[0])).toBe(serialized);
  });

  it('keeps arithmetic filter-only and rejects malformed or unsafe expressions', () => {
    expect(() => parseProgram('computed(X + 1).')).toThrow(ParseError);
    expect(() => parseQuery('metric(X, A), A + _ > 2')).toThrow(/wildcard/i);
    expect(() => parseQuery('metric(X, A), A + banana > 2')).toThrow(
      /numbers and variables/i
    );
    expect(() => parseQuery('metric(X, A), A + > 2')).toThrow(ParseError);
    expect(() => parseQuery('metric(X, A), A / 2')).toThrow(/comparison/i);
  });

  it('caps arithmetic expression complexity', () => {
    const expression = Array.from({ length: 70 }, () => 'A').join(' + ');
    expect(() => parseQuery(`metric(X, A), ${expression} > 0`)).toThrow(
      /depth|complex/i
    );
  });

  it('rejects recursion through negation', () => {
    expect(() => parseProgram('p :- \\+ p.')).toThrow(StratificationError);
    expect(() => parseProgram('p :- \\+ q. q :- \\+ p.')).toThrow(StratificationError);
    expect(() => parseProgram('p :- q. q :- \\+ p.')).toThrow(StratificationError);
  });

  it('rejects missing final period', () => {
    expect(() => parseProgram('person(rahul)')).toThrow(ParseError);
  });

  it('reports line numbers in parse errors', () => {
    try {
      parseProgram('person(rahul).\nperson(.');
      expect.unreachable();
    } catch (e) {
      expect((e as ParseError).message).toMatch(/line 2/i);
    }
  });
});

describe('parseQuery', () => {
  it('parses a single-literal query', () => {
    const q = parseQuery('works_at(X, acme)');
    expect(q).toHaveLength(1);
    expect(q[0]).toEqual({
      predicate: 'works_at',
      args: [
        { type: 'var', name: 'X' },
        { type: 'atom', value: 'acme' },
      ],
    });
  });

  it('parses a conjunctive query with comparison, optional trailing period', () => {
    const q = parseQuery('works_at(X, C), based_in(C, sydney), X != rahul.');
    expect(q).toHaveLength(3);
  });

  it('allows wildcards in queries', () => {
    const q = parseQuery('works_at(rahul, _)');
    expect(q[0].args[1].type).toBe('wildcard');
  });

  it('allows safe query negation and rejects unbound negative variables', () => {
    expect(parseQuery('employee(X), \\+ suspended(X)')).toHaveLength(2);
    expect(parseQuery('\\+ suspended(rahul)')).toEqual([
      { not: { predicate: 'suspended', args: [{ type: 'atom', value: 'rahul' }] } },
    ]);
    expect(() => parseQuery('\\+ suspended(X)')).toThrow(/earlier positive/i);
  });

  it('rejects empty queries', () => {
    expect(() => parseQuery('   ')).toThrow(ParseError);
  });
});

describe('parseQuerySpec', () => {
  it('keeps ordinary relational queries additive and unchanged', () => {
    expect(parseQuerySpec('works_at(Person, acme)')).toEqual({
      kind: 'relational',
      goals: parseQuery('works_at(Person, acme)'),
    });
  });

  it('parses and serializes scalar aggregate queries canonically', () => {
    const count = parseQuerySpec(
      '?- count(*) as Count where works_at(Person, acme).'
    );
    expect(count).toEqual({
      kind: 'aggregate',
      op: 'count',
      input: '*',
      as: 'Count',
      goals: parseQuery('works_at(Person, acme)'),
    });
    expect(serializeQuerySpec(count)).toBe(
      'count(*) as Count where works_at(Person, acme)'
    );

    const sum = parseQuerySpec(
      'sum(Points) as Total where score(Player, Team, Points), Team = red'
    );
    expect(sum).toMatchObject({
      kind: 'aggregate',
      op: 'sum',
      input: 'Points',
      as: 'Total',
    });
    expect(serializeQuerySpec(sum)).toBe(
      'sum(Points) as Total where score(Player, Team, Points), Team = red'
    );
  });

  it('does not steal ordinary predicates named like aggregate operators', () => {
    expect(parseQuerySpec('count(Item)')).toEqual({
      kind: 'relational',
      goals: parseQuery('count(Item)'),
    });
  });

  it('requires safe query-only aggregate inputs and a fresh output alias', () => {
    expect(() =>
      parseQuerySpec('count(Person) as Total where employee(Person)')
    ).toThrow(/count\(\*\)/i);
    expect(() =>
      parseQuerySpec('sum(10) as Total where score(Player, Points)')
    ).toThrow(/variable/i);
    expect(() =>
      parseQuerySpec('sum(Points) as Total where score(Player, Value)')
    ).toThrow(/bound by a positive/i);
    expect(() =>
      parseQuerySpec('sum(Points) as Player where score(Player, Points)')
    ).toThrow(/fresh/i);
    expect(() =>
      parseQuerySpec('count(*) as Count where \\+ suspended(alice)')
    ).toThrow(/positive relation/i);
  });

  it('allows count over a positive ground or zero-arity relation', () => {
    expect(parseQuerySpec('count(*) as Count where works_at(alice, acme)')).toMatchObject({
      kind: 'aggregate',
      op: 'count',
    });
    expect(parseQuerySpec('count(*) as Count where initialized')).toMatchObject({
      kind: 'aggregate',
      op: 'count',
    });
  });

  it('keeps aggregate syntax out of clauses and retraction-style relational parsing', () => {
    expect(() =>
      parseProgram('total(T) :- count(*) as T where item(X).')
    ).toThrow(ParseError);
    expect(() =>
      parseQuery('count(*) as Count where employee(Person)')
    ).toThrow(ParseError);
  });
});

describe('serializeClause', () => {
  it('round-trips facts and rules canonically', () => {
    const [fact] = parseProgram("likes(rahul,   'Flat White').");
    expect(serializeClause(fact)).toBe("likes(rahul, 'Flat White').");
    const [rule] = parseProgram('colleague(X,Y):-works_at(X,C),works_at(Y,C),X!=Y.');
    expect(serializeClause(rule)).toBe(
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'
    );
    // canonical form is stable under re-parse
    expect(serializeClause(parseProgram(serializeClause(rule))[0])).toBe(
      serializeClause(rule)
    );
  });

  it('quotes atoms only when needed', () => {
    const [fact] = parseProgram("f(abc, 'abc def', 'Abc', 42).");
    expect(serializeClause(fact)).toBe("f(abc, 'abc def', 'Abc', 42).");
  });

  it('canonicalizes alpha-equivalent arithmetic rules deterministically', () => {
    const [left] = parseProgram(
      'ahead(X) :- score(X, A), baseline(B), A > B + 5.'
    );
    const [right] = parseProgram(
      'ahead(Person) :- score(Person, Score), baseline(Base), Score > Base + 5.'
    );
    expect(canonicalKey(left)).toBe(canonicalKey(right));
  });
});
