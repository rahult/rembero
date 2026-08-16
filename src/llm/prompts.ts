import { type Clause, predKey, serializeClause } from '../engine/index.js';

export const NOTHING_SENTINEL = '% nothing';
export const UNANSWERABLE = 'unanswerable';

export type QueryPromptVariant = 'baseline' | 'grounded';

/** Predicates with arities and up to 3 sample facts each, plus all rules verbatim. */
export function buildSchemaSummary(clauses: Clause[]): string {
  const facts = clauses.filter((c) => c.body.length === 0);
  const rules = clauses.filter((c) => c.body.length > 0);
  if (facts.length === 0 && rules.length === 0) return '% (no memories yet)';

  const byPredicate = new Map<string, string[]>();
  for (const fact of facts) {
    const key = predKey(fact.head);
    const samples = byPredicate.get(key) ?? [];
    if (samples.length < 3) samples.push(serializeClause(fact));
    byPredicate.set(key, samples);
  }
  for (const rule of rules) {
    if (!byPredicate.has(predKey(rule.head))) byPredicate.set(predKey(rule.head), []);
  }

  const lines: string[] = ['% predicates (name/arity, with sample facts)'];
  for (const [key, samples] of byPredicate) {
    lines.push(samples.length > 0 ? `${key}  e.g. ${samples.join('  ')}` : `${key}  (derived)`);
  }
  if (rules.length > 0) {
    lines.push('% rules');
    for (const rule of rules) lines.push(serializeClause(rule));
  }
  return lines.join('\n');
}

export function extractionSystemPrompt(schemaSummary: string): string {
  return `You convert natural-language statements into Datalog clauses for a memory system.

Output one clause per line and nothing else — no prose, no code fences.
- Fact: pred(arg1, arg2).  Rule: head(X, Y) :- body1(X, Z), body2(Z, Y).
- Predicates and constants: lowercase snake_case (works_at, acme). Variables: uppercase (X, Person).
- Multi-word or case-sensitive constants must be single-quoted: 'New York'. Prefer short lowercase atoms when natural (rahul, not 'Rahul').
- Numbers are bare: birth_year(rahul, 1985).
- Rule bodies may use comparisons: =, !=, <, >, <=, >=. No negation, no arithmetic, no aggregation.
- Facts must be ground (no variables). Every variable in a rule head must appear in a body relation.
- Prefer several small binary facts over one wide fact. Emit a rule only when the input states a general relationship ("every X who ... is ...").
- For relations that should never relate a thing to itself (colleague, sibling, neighbor, ...), add an inequality to the rule body: colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.
- Reuse predicates from the existing schema below when they fit; invent new ones only when needed.
- When the input says something CHANGED or is no longer true ("now works at", "moved to", "no longer"), first retract the outdated fact with a retract line, then assert the new one:
  retract works_at(mira, _).
  works_at(mira, initech).
  Only retract facts the schema shows could exist. Never retract when the input merely adds information.
- NEVER extract secrets: passwords, API keys, tokens, credit card or account numbers. Skip them even if the rest of the sentence is stored.
- If nothing factual can be extracted, output exactly: ${NOTHING_SENTINEL}

Existing schema:
${schemaSummary}`;
}

export function queryGenSystemPrompt(
  schemaSummary: string,
  variant: QueryPromptVariant = 'grounded'
): string {
  const grounding =
    variant === 'grounded'
      ? `
- Treat schema examples as syntax evidence only, never as the answer. Do not copy an example constant unless the question names it.
- Bind every entity named in the question as a lowercase or quoted constant, even when the natural-language name is capitalized. Datalog variables represent requested unknown answers, not capitalized words.
- A named entity may be absent from the examples and is still a valid constant. If the predicate exists, query that entity and let an empty result show that no fact matches.
- Questions beginning with does, is, are, was, were, or can are normally yes/no questions. When their relation and arguments are all named, emit a ground query with zero variables and every named argument fixed.
- Pattern examples: "Does Alex work at Globex?" becomes ?- works_at(alex, globex). "Where does Nia work?" becomes ?- works_at(nia, Company). The first has no requested unknown; the second has exactly one.
- A why/reason question is unanswerable unless the schema has a predicate that stores a cause or reason. A related fact does not explain why it is true.
- Prefer the predicate whose meaning directly matches the question, including a derived predicate when one is available.
- Add multiple goals only when the question requires a join or an explicit constraint.
- If the schema can express the question, emit the query even when it may return no rows. Use unanswerable only when no shown predicate can express the question.`
      : '';
  return `You translate a question into one Datalog query over the schema below.
Output exactly one line of the form: ?- goal1, goal2, ... .
Use uppercase variables for the unknowns the question asks about. Only use predicates that appear in the schema, with matching arity. Comparisons =, !=, <, >, <=, >= are allowed. No negation.
If the question cannot be expressed with these predicates, output exactly: ?- ${UNANSWERABLE}.${grounding}

Schema:
${schemaSummary}`;
}

export const PHRASING_SYSTEM_PROMPT = `Answer the user's question in one or two plain sentences using only the query results below. If the results are empty, say you don't have any memory of that. Never mention Datalog, queries, or variables.`;

export function phrasingUserPrompt(
  question: string,
  query: string,
  bindings: Record<string, string>[]
): string {
  return `Question: ${question}
Query used: ${query}
Results: ${JSON.stringify(bindings)}`;
}
