import {
  evaluateQuerySpecWithProof,
  isIntegrityConstraint,
  parseProgram,
  parseQuerySpec,
  serializeClause,
  serializeTerm,
  type Clause,
  type ProofStep,
  type QueryProof,
  type Term,
} from "./engine";

export type DemoQuestionId = "collaborator" | "follow_up" | "gift";

export interface DemoQuestion {
  id: DemoQuestionId;
  label: string;
  query: string;
}

export interface DemoResult {
  status: "supported" | "not_proven";
  question: DemoQuestion;
  answer: string;
  bindings: Record<string, string>[];
  claims: string[];
  rule?: string;
  source?: string;
  whyNot?: string;
  related: Array<{ clause: string; context: string }>;
}

export const BASE_PROGRAM = `
  project(atlas).
  project_owner(atlas, rahul).
  project_contributor(atlas, maya).
  promised_update(rahul, maya, atlas).
  status(atlas, blocked).
  prefers_meeting(maya, morning).

  collaborator(Person, Project) :-
    project_owner(Project, Owner),
    project_contributor(Project, Person),
    Owner != Person.

  needs_follow_up(Person, Project) :-
    promised_update(rahul, Person, Project),
    status(Project, blocked).
`;

export const DEMO_QUESTIONS: readonly DemoQuestion[] = [
  {
    id: "collaborator",
    label: "Who is collaborating on Atlas?",
    query: "collaborator(Person, atlas)",
  },
  {
    id: "follow_up",
    label: "What follow-up do I owe Maya?",
    query: "needs_follow_up(maya, Project)",
  },
  {
    id: "gift",
    label: "What gift does Maya want?",
    query: "prefers_gift(maya, Gift)",
  },
] as const;

export const SESSION_GIFT_FACT = "prefers_gift(maya, notebook).";

const SOURCE_BY_CLAUSE = new Map<string, string>([
  ["project_owner(atlas, rahul).", "Atlas planning session · 17 Aug 2026"],
  ["project_contributor(atlas, maya).", "Atlas planning session · 17 Aug 2026"],
  ["promised_update(rahul, maya, atlas).", "Atlas planning session · 17 Aug 2026"],
  ["status(atlas, blocked).", "Atlas planning session · 17 Aug 2026"],
  ["prefers_meeting(maya, morning).", "Personal directory · 15 Aug 2026"],
  [SESSION_GIFT_FACT, "Session-only source · just now"],
]);

const RELATED_GIFT_CONTEXT = [
  {
    clause: "prefers_meeting(maya, morning).",
    context: "A nearby preference, not evidence about gifts.",
  },
  {
    clause: "project_contributor(atlas, maya).",
    context: "A related Maya fact, not an answer.",
  },
];

function termText(term: Term): string {
  return serializeTerm(term);
}

function claimText(proof: ProofStep): string | undefined {
  if ("negated" in proof) return undefined;
  return `${proof.predicate}(${proof.values
    .map((value) =>
      termText(
        typeof value === "number"
          ? { type: "num", value }
          : { type: "atom", value },
      ),
    )
    .join(", ")}).`;
}

function collectLeaves(proof: QueryProof, claims: string[]): void {
  if ("aggregated" in proof) {
    for (const contributor of proof.contributors) {
      for (const child of contributor.proofs) collectLeaves(child, claims);
    }
    return;
  }
  if ("negated" in proof) return;
  if (proof.rule === undefined) {
    const claim = claimText(proof);
    if (claim !== undefined && !claims.includes(claim)) claims.push(claim);
  }
  for (const child of proof.because ?? []) collectLeaves(child, claims);
  for (const contributor of proof.aggregate?.contributors ?? []) {
    for (const child of contributor.proofs) collectLeaves(child, claims);
  }
}

function authoredRules(clauses: Clause[]): string[] {
  return clauses
    .filter((clause) => clause.body.length > 0 && !isIntegrityConstraint(clause))
    .map(serializeClause);
}

function friendlyAnswer(
  id: DemoQuestionId,
  binding: Record<string, string>,
): string {
  if (id === "collaborator") return `${title(binding.Person)} is collaborating on Atlas.`;
  if (id === "follow_up") return `You owe Maya an update on ${title(binding.Project)}.`;
  return `Maya would like a ${title(binding.Gift).toLowerCase()}.`;
}

function title(value = "the result"): string {
  return value
    .replace(/^'(.*)'$/, "$1")
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function runDemo(program: string, id: DemoQuestionId): DemoResult {
  const question = DEMO_QUESTIONS.find((item) => item.id === id)!;
  const clauses = parseProgram(program);
  const rows = evaluateQuerySpecWithProof(clauses, parseQuerySpec(question.query), {
    maxFacts: 100,
    maxIterations: 16,
    maxRows: 8,
    maxProofDepth: 16,
    maxProofNodes: 256,
    maxProofsPerRow: 1,
    maxAggregateRows: 128,
    maxAggregateProofRows: 32,
  });
  if (rows.length === 0) {
    return {
      status: "not_proven",
      question,
      answer: `We don’t have a supported answer to “${question.label}”`,
      bindings: [],
      claims: [],
      whyNot: "Required fact prefers_gift(maya, Gift) is missing.",
      related: id === "gift" ? RELATED_GIFT_CONTEXT : [],
    };
  }

  const row = rows[0];
  const bindings = Object.fromEntries(
    Object.entries(row.bindings).map(([name, term]) => [name, termText(term)]),
  );
  const claims: string[] = [];
  for (const proof of row.proofs) collectLeaves(proof, claims);
  let ruleNumber: number | undefined;
  for (const proof of row.proofs) {
    if ("negated" in proof || "aggregated" in proof) continue;
    if (proof.rule !== undefined) {
      ruleNumber = proof.rule;
      break;
    }
  }
  const rules = authoredRules(clauses);
  const source = claims
    .map((claim) => SOURCE_BY_CLAUSE.get(claim))
    .find((value): value is string => value !== undefined);

  return {
    status: "supported",
    question,
    answer: friendlyAnswer(id, bindings),
    bindings: [bindings],
    claims,
    ...(ruleNumber === undefined ? {} : { rule: rules[ruleNumber - 1] }),
    ...(source === undefined ? {} : { source }),
    related: [],
  };
}
