import {
  evaluateQuerySpecWithProof,
  isIntegrityConstraint,
  parseProgram,
  parseQuerySpec,
  serializeClause,
  serializeTerm,
  type Clause,
  type QueryProof,
  type Term,
} from "./engine";

export type GroundedAgentCaseId =
  | "safe_refund"
  | "identity_dispute"
  | "missing_evidence";

export type GroundedAgentProposal = "approve_refund" | "handoff";

export interface GroundedAgentScenario {
  id: GroundedAgentCaseId;
  label: string;
  ticketAtom: string;
  ticketLabel: string;
  amount: number;
  requestHeadline: string;
  customerMessage: string;
  promptOnlyOutcome: string;
  groundedApproveCopy: string;
  groundedEscalateCopy: string;
  recallFacts: readonly string[];
  program: string;
}

export interface GroundedAgentDecision {
  scenario: GroundedAgentScenario;
  status: "approve" | "escalate";
  outcome: string;
  decisionQuery: string;
  evaluationResult: boolean;
  activeRule: string;
  proofChain: string[];
  badgeTitle: string;
  badgeBody: string;
  proposedAction: GroundedAgentProposal;
  proposalFact: string;
}

const ENGINE_OPTIONS = {
  maxFacts: 100,
  maxIterations: 16,
  maxRows: 8,
  maxProofDepth: 16,
  maxProofNodes: 256,
  maxProofsPerRow: 1,
  maxAggregateRows: 128,
  maxAggregateProofRows: 32,
} as const;

export const GROUNDED_AGENT_SCENARIOS: readonly GroundedAgentScenario[] = [
  {
    id: "safe_refund",
    label: "Safe refund",
    ticketAtom: "t_204",
    ticketLabel: "T-204",
    amount: 42,
    requestHeadline: "Refund ticket T-204 · $42 · evidence complete",
    customerMessage: "The item arrived damaged. Please issue the refund.",
    promptOnlyOutcome: "APPROVE REFUND",
    groundedApproveCopy: "Approve refund.",
    groundedEscalateCopy: "Escalate to a human.",
    recallFacts: [
      "request(t_204, refund)",
      "amount(t_204, 42)",
      "inside_auto_refund_window(t_204)",
      "verified_order(t_204)",
    ],
    program: `
      request(t_204, refund).
      amount(t_204, 42).
      inside_auto_refund_window(t_204).
      verified_order(t_204).

      approve_refund(Ticket) :-
        request(Ticket, refund),
        inside_auto_refund_window(Ticket),
        verified_order(Ticket).

      requires_human(Ticket) :-
        disputed_identity(Ticket).

      requires_human(Ticket) :-
        missing_evidence(Ticket).
    `,
  },
  {
    id: "identity_dispute",
    label: "Identity dispute",
    ticketAtom: "t_418",
    ticketLabel: "T-418",
    amount: 249,
    requestHeadline: "Refund ticket T-418 · $249 · identity disputed",
    customerMessage: "Please refund this order today.",
    promptOnlyOutcome: "APPROVE REFUND",
    groundedApproveCopy: "Approve refund.",
    groundedEscalateCopy: "Escalate to a human.",
    recallFacts: [
      "request(t_418, refund)",
      "amount(t_418, 249)",
      "disputed_identity(t_418)",
    ],
    program: `
      request(t_418, refund).
      amount(t_418, 249).
      disputed_identity(t_418).

      approve_refund(Ticket) :-
        request(Ticket, refund),
        inside_auto_refund_window(Ticket),
        verified_order(Ticket).

      requires_human(Ticket) :-
        disputed_identity(Ticket).

      requires_human(Ticket) :-
        missing_evidence(Ticket).
    `,
  },
  {
    id: "missing_evidence",
    label: "Missing evidence",
    ticketAtom: "t_552",
    ticketLabel: "T-552",
    amount: 89,
    requestHeadline: "Refund ticket T-552 · $89 · evidence missing",
    customerMessage: "Refund this card charge please.",
    promptOnlyOutcome: "APPROVE REFUND",
    groundedApproveCopy: "Approve refund.",
    groundedEscalateCopy: "Escalate to a human.",
    recallFacts: [
      "request(t_552, refund)",
      "amount(t_552, 89)",
      "missing_evidence(t_552)",
    ],
    program: `
      request(t_552, refund).
      amount(t_552, 89).
      missing_evidence(t_552).

      approve_refund(Ticket) :-
        request(Ticket, refund),
        inside_auto_refund_window(Ticket),
        verified_order(Ticket).

      requires_human(Ticket) :-
        disputed_identity(Ticket).

      requires_human(Ticket) :-
        missing_evidence(Ticket).
    `,
  },
] as const;

function scenarioById(id: GroundedAgentCaseId): GroundedAgentScenario {
  const scenario = GROUNDED_AGENT_SCENARIOS.find((entry) => entry.id === id);
  if (scenario === undefined) throw new Error(`Unknown grounded-agent scenario ${id}`);
  return scenario;
}

function termText(term: Term): string {
  return serializeTerm(term);
}

function claimText(proof: QueryProof): string {
  if ("aggregated" in proof) {
    return `${proof.op}(${proof.input}) as ${proof.as} = ${proof.value}`;
  }
  if ("negated" in proof) {
    return `not ${proof.predicate}(${proof.pattern
      .map((value) => (value === null ? "_" : value))
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
    .join(", ")})`;
}

function collectProofLines(proof: QueryProof, lines: string[]): void {
  if (!lines.includes(claimText(proof))) lines.push(claimText(proof));
  if ("aggregated" in proof) {
    for (const contributor of proof.contributors) {
      for (const child of contributor.proofs) collectProofLines(child, lines);
    }
    return;
  }
  if ("negated" in proof) return;
  for (const child of proof.because ?? []) collectProofLines(child, lines);
  for (const contributor of proof.aggregate?.contributors ?? []) {
    for (const child of contributor.proofs) collectProofLines(child, lines);
  }
}

function authoredRules(clauses: Clause[]): string[] {
  return clauses
    .filter((clause) => clause.body.length > 0 && !isIntegrityConstraint(clause))
    .map(serializeClause);
}

function firstRuleNumber(proofs: readonly QueryProof[]): number | undefined {
  for (const proof of proofs) {
    if ("aggregated" in proof || "negated" in proof) continue;
    if (proof.rule !== undefined) return proof.rule;
    const nested = firstRuleNumber(proof.because ?? []);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function evaluateGroundedAgentCase(
  id: GroundedAgentCaseId,
  proposedAction: GroundedAgentProposal = "approve_refund",
): GroundedAgentDecision {
  const scenario = scenarioById(id);
  const proposalFact = `proposed_action(${scenario.ticketAtom}, ${proposedAction})`;
  const clauses = parseProgram(`${scenario.program}
    ${proposalFact}.

    action_allowed(Ticket, handoff) :-
      proposed_action(Ticket, handoff).

    action_allowed(Ticket, approve_refund) :-
      proposed_action(Ticket, approve_refund),
      approve_refund(Ticket),
      \\+ requires_human(Ticket).

    action_blocked(Ticket, approve_refund) :-
      proposed_action(Ticket, approve_refund),
      requires_human(Ticket).
  `);
  const rules = authoredRules(clauses);
  const allowedQuery = `action_allowed(${scenario.ticketAtom}, ${proposedAction})`;
  const blockedQuery = `action_blocked(${scenario.ticketAtom}, ${proposedAction})`;
  const allowedRows = evaluateQuerySpecWithProof(
    clauses,
    parseQuerySpec(allowedQuery),
    ENGINE_OPTIONS,
  );

  if (allowedRows.length > 0) {
    const proof = allowedRows[0].proofs[0];
    const proofChain: string[] = [];
    if (proof !== undefined) collectProofLines(proof, proofChain);
    const ruleNumber = firstRuleNumber(allowedRows[0].proofs);
    const approvedRefund = proposedAction === "approve_refund";
    return {
      scenario,
      status: approvedRefund ? "approve" : "escalate",
      outcome: approvedRefund
        ? scenario.groundedApproveCopy
        : scenario.groundedEscalateCopy,
      decisionQuery: allowedQuery,
      evaluationResult: true,
      activeRule: ruleNumber === undefined ? "No active rule" : rules[ruleNumber - 1],
      proofChain,
      badgeTitle: approvedRefund ? "Refund approved" : "Handoff allowed",
      badgeBody: approvedRefund
        ? "Policy gate allowed the proposed refund with verified evidence."
        : "The non-mutating handoff proposal passed the policy gate.",
      proposedAction,
      proposalFact,
    };
  }

  const blockedRows = evaluateQuerySpecWithProof(
    clauses,
    parseQuerySpec(blockedQuery),
    ENGINE_OPTIONS,
  );
  if (blockedRows.length === 0) {
    throw new Error(`Scenario ${id}/${proposedAction} produced no deterministic gate result`);
  }

  const proof = blockedRows[0].proofs[0];
  const proofChain: string[] = [];
  if (proof !== undefined) collectProofLines(proof, proofChain);
  const ruleNumber = firstRuleNumber(blockedRows[0].proofs);
  return {
    scenario,
    status: "escalate",
    outcome: scenario.groundedEscalateCopy,
    decisionQuery: blockedQuery,
    evaluationResult: true,
    activeRule: ruleNumber === undefined ? "No active rule" : rules[ruleNumber - 1],
    proofChain,
    badgeTitle: id === "identity_dispute" ? "Refund blocked" : "Hold for evidence",
    badgeBody:
      id === "identity_dispute"
        ? "Policy gate blocked the proposed refund due to disputed identity."
        : "Policy gate blocked the proposed refund because key evidence is missing.",
    proposedAction,
    proposalFact,
  };
}
