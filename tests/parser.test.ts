import { describe, it, expect } from 'vitest';
import {
  parseProgram,
  parseQuery,
  serializeClause,
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
});
