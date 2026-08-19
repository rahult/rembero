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

export type ChatMemoryScenarioId =
  | "schedule-review"
  | "follow-up-maya"
  | "unknown-preference";

export interface ChatMemoryScenario {
  id: ChatMemoryScenarioId;
  label: string;
  question: string;
  baselineAnswer: string;
  query: string;
  program: string;
  requiredTerms: readonly string[];
}

export interface ChatMemoryRun {
  answer: string;
  claims: string[];
  absences: string[];
  proofTrail: string[];
  rule?: string;
  bindings: Record<string, string>;
  factCount: number;
  ruleCount: number;
  absenceCount: number;
  facts: string[];
  rules: string[];
  query: string;
}

export const CHAT_MEMORY_SCENARIOS: readonly ChatMemoryScenario[] = [
  {
    id: "schedule-review",
    label: "Schedule the review",
    question: "When should I schedule the Atlas review?",
    baselineAnswer:
      "Atlas is blocked by the vendor security review, and Maya prefers mornings. The raw snapshot still has to be interpreted.",
    query: "schedule_review(atlas, Day, Window, Blocker)",
    requiredTerms: ["tuesday", "morning", "vendor security review"],
    program: `
      status(atlas, blocked).
      blocker(atlas, vendor_security_review).
      prefers_meeting(maya, morning).
      review_slot(atlas, tuesday, morning).

      schedule_review(Project, Day, Window, Blocker) :-
        review_slot(Project, Day, Window),
        status(Project, blocked),
        blocker(Project, Blocker),
        prefers_meeting(maya, Window).
    `,
  },
  {
    id: "follow-up-maya",
    label: "Follow up with Maya",
    question: "Should I follow up with Maya today?",
    baselineAnswer:
      "The snapshot shows a promised Atlas update to Maya and a blocked project, so following up today is reasonable.",
    query: "needs_follow_up(maya, Project)",
    requiredTerms: ["maya", "atlas", "follow up"],
    program: `
      promised_update(rahul, maya, atlas).
      status(atlas, blocked).

      needs_follow_up(Person, Project) :-
        promised_update(rahul, Person, Project),
        status(Project, blocked).
    `,
  },
  {
    id: "unknown-preference",
    label: "Unknown preference",
    question: "Should I book Jordan for the morning sync?",
    baselineAnswer:
      "The complete snapshot has Jordan’s sync but no stored meeting preference, so ask before booking.",
    query: "missing_preference(jordan)",
    requiredTerms: ["jordan", "ask", "preference"],
    program: `
      pending_meeting(jordan, roadmap_sync).

      missing_preference(Person) :-
        pending_meeting(Person, _),
        \\+ prefers_meeting(Person, _).
    `,
  },
] as const;

function termText(term: Term): string {
  return serializeTerm(term);
}

function proofText(proof: ProofStep): string {
  if ("negated" in proof) {
    return `not ${proof.predicate}(${proof.pattern
      .map((value) => {
        if (value === null) return "_";
        return typeof value === "number"
          ? termText({ type: "num", value })
          : termText({ type: "atom", value });
      })
      .join(", ")})`;
  }

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

function addUnique(target: string[], value?: string): void {
  if (value === undefined || target.includes(value)) return;
  target.push(value);
}

function collectProof(
  proof: QueryProof,
  claims: string[],
  absences: string[],
  trail: string[],
  depth = 0,
): void {
  const prefix = `${"  ".repeat(depth)}${depth === 0 ? "" : "↳ "}`;

  if ("aggregated" in proof) {
    addUnique(
      trail,
      `${prefix}${proof.op}(${proof.input}) as ${proof.as} = ${proof.value}`,
    );
    for (const contributor of proof.contributors) {
      for (const child of contributor.proofs) {
        collectProof(child, claims, absences, trail, depth + 1);
      }
    }
    return;
  }

  if ("negated" in proof) {
    const absence = proofText(proof);
    addUnique(absences, absence);
    addUnique(trail, `${prefix}${absence}`);
    return;
  }

  const claim = proofText(proof);
  if (proof.rule === undefined) addUnique(claims, claim);
  addUnique(
    trail,
    proof.rule === undefined
      ? `${prefix}${claim}`
      : `${prefix}${claim} via rule ${proof.rule}`,
  );

  for (const child of proof.because ?? []) {
    collectProof(child, claims, absences, trail, depth + 1);
  }

  for (const contributor of proof.aggregate?.contributors ?? []) {
    for (const child of contributor.proofs) {
      collectProof(child, claims, absences, trail, depth + 1);
    }
  }
}

function authoredRules(clauses: Clause[]): string[] {
  return clauses
    .filter((clause) => clause.body.length > 0 && !isIntegrityConstraint(clause))
    .map(serializeClause);
}

function factsOnly(clauses: Clause[]): string[] {
  return clauses
    .filter((clause) => clause.body.length === 0)
    .map(serializeClause);
}

function title(value: string): string {
  return value
    .replace(/^'(.*)'$/, "$1")
    .split("_")
    .map((part) =>
      part.length === 0
        ? part
        : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function scenarioAnswer(
  scenario: ChatMemoryScenario,
  bindings: Record<string, string>,
  absences: string[],
): string {
  switch (scenario.id) {
    case "schedule-review":
      return `${title(bindings.Day)} ${bindings.Window}, after the ${title(bindings.Blocker).toLowerCase()}. Maya prefers mornings.`;
    case "follow-up-maya":
      return `Yes. Follow up with Maya about ${title(bindings.Project)} today. You already owe her an update, and the project is blocked.`;
    case "unknown-preference":
      return absences.length > 0
        ? "Don’t guess. Ask Jordan first because no meeting preference is stored."
        : "I don’t have a grounded preference for Jordan.";
  }
}

export function runChatMemoryScenario(id: ChatMemoryScenarioId): ChatMemoryRun {
  const scenario = CHAT_MEMORY_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Unknown chat memory scenario: ${id}`);
  }

  const clauses = parseProgram(scenario.program);
  const rows = evaluateQuerySpecWithProof(clauses, parseQuerySpec(scenario.query), {
    maxFacts: 64,
    maxIterations: 16,
    maxRows: 4,
    maxProofDepth: 16,
    maxProofNodes: 256,
    maxProofsPerRow: 1,
    maxAggregateRows: 64,
    maxAggregateProofRows: 16,
  });

  const facts = factsOnly(clauses);
  const rules = authoredRules(clauses);
  if (rows.length === 0) {
    return {
      answer: "No supported answer was proven.",
      claims: [],
      absences: [],
      proofTrail: [],
      bindings: {},
      factCount: 0,
      ruleCount: 0,
      absenceCount: 0,
      facts,
      rules,
      query: scenario.query,
    };
  }

  const row = rows[0];
  const bindings = Object.fromEntries(
    Object.entries(row.bindings).map(([key, value]) => [key, termText(value)]),
  );
  const claims: string[] = [];
  const absences: string[] = [];
  const proofTrail: string[] = [];
  const usedRules = new Set<number>();

  for (const proof of row.proofs) {
    if (!("aggregated" in proof) && !("negated" in proof) && proof.rule !== undefined) {
      usedRules.add(proof.rule);
    }
    collectProof(proof, claims, absences, proofTrail);
  }

  const rule =
    usedRules.size > 0
      ? rules[[...usedRules][0] - 1]
      : undefined;

  return {
    answer: scenarioAnswer(scenario, bindings, absences),
    claims,
    absences,
    proofTrail,
    ...(rule ? { rule } : {}),
    bindings,
    factCount: claims.length,
    ruleCount: usedRules.size,
    absenceCount: absences.length,
    facts,
    rules,
    query: scenario.query,
  };
}
