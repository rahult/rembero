import type {
  MemoryCell,
  MemoryStackCase,
  MemoryStackLabel,
} from './memory-stack-contract.js';

const atom = (value: string): MemoryCell => ({ type: 'atom', value });

const noiseEvents = Array.from({ length: 100 }, (_, index) => ({
  id: `direct-noise-${String(index).padStart(3, '0')}`,
  at: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  text: `Noise subject ${index} has value ${index}.`,
  clauses: `noise_${String(index).padStart(3, '0')}(subject_${index}, value_${index}).`,
  trust: 'accepted' as const,
}));

export const MEMORY_STACK_CASES: MemoryStackCase[] = [
  {
    id: 'direct_fact_at_scale',
    tags: ['direct', 'distractors', 'retrieval'],
    events: [
      ...noiseEvents,
      {
        id: 'direct-employer',
        at: '2026-04-01T09:00:00.000Z',
        text: 'Rahul works at Acme.',
        clauses: 'works_at(rahul, acme).',
        trust: 'accepted',
      },
    ],
    questions: [
      {
        id: 'direct-employer-question',
        text: 'Where does Rahul work?',
        query: 'works_at(rahul, Company)',
        answerColumns: ['Company'],
        topK: 5,
      },
    ],
  },
  {
    id: 'multi_hop_rule',
    tags: ['derived', 'multi-hop', 'provenance'],
    events: [
      {
        id: 'atlas-owner',
        at: '2026-05-01T09:00:00.000Z',
        text: 'Rahul owns Atlas.',
        clauses: 'project_owner(atlas, rahul).',
        trust: 'accepted',
      },
      {
        id: 'atlas-contributor',
        at: '2026-05-02T09:00:00.000Z',
        text: 'Maya contributes to Atlas.',
        clauses: 'project_contributor(atlas, maya).',
        trust: 'accepted',
      },
      {
        id: 'collaborator-rule',
        at: '2026-05-03T09:00:00.000Z',
        text: 'A contributor is a collaborator when someone else owns the project.',
        clauses:
          'collaborator(Person, Project) :- project_owner(Project, Owner), project_contributor(Project, Person), Owner != Person.',
        trust: 'accepted',
      },
    ],
    questions: [
      {
        id: 'atlas-collaborator-question',
        text: 'Who is collaborating on Atlas?',
        query: 'collaborator(Person, atlas)',
        answerColumns: ['Person'],
      },
    ],
  },
  {
    id: 'recursive_reasoning',
    tags: ['derived', 'recursive', 'multi-hop'],
    events: [
      {
        id: 'parent-alice-bob',
        at: '2026-05-10T09:00:00.000Z',
        text: 'Alice is Bob’s parent.',
        clauses: 'parent(alice, bob).',
        trust: 'accepted',
      },
      {
        id: 'parent-bob-carol',
        at: '2026-05-11T09:00:00.000Z',
        text: 'Bob is Carol’s parent.',
        clauses: 'parent(bob, carol).',
        trust: 'accepted',
      },
      {
        id: 'parent-carol-dan',
        at: '2026-05-12T09:00:00.000Z',
        text: 'Carol is Dan’s parent.',
        clauses: 'parent(carol, dan).',
        trust: 'accepted',
      },
      {
        id: 'ancestor-rules',
        at: '2026-05-13T09:00:00.000Z',
        text: 'Parents are ancestors, and ancestry is transitive.',
        clauses:
          'ancestor(X, Y) :- parent(X, Y). ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).',
        trust: 'accepted',
      },
    ],
    questions: [
      {
        id: 'alice-descendants-question',
        text: 'Who are Alice’s descendants?',
        query: 'ancestor(alice, Person)',
        answerColumns: ['Person'],
      },
    ],
  },
  {
    id: 'temporal_update',
    tags: ['temporal', 'knowledge-update', 'stale-evidence'],
    events: [
      {
        id: 'employment-old',
        at: '2026-01-01T09:00:00.000Z',
        text: 'Ava worked at Northwind at revision 1.',
        clauses: 'employment(ava, northwind, 1).',
        trust: 'accepted',
      },
      {
        id: 'employment-new',
        at: '2026-06-01T09:00:00.000Z',
        text: 'Ava now works at Initech at revision 2.',
        clauses: 'employment(ava, initech, 2).',
        trust: 'accepted',
      },
      {
        id: 'current-employment-rules',
        at: '2026-06-01T09:01:00.000Z',
        text: 'The current employer is the employer at the greatest revision.',
        clauses:
          'latest_employment(Person, Latest) :- max(Revision) as Latest where employment(Person, Company, Revision). current_employer(Person, Company) :- latest_employment(Person, Revision), employment(Person, Company, Revision).',
        trust: 'accepted',
      },
    ],
    questions: [
      {
        id: 'current-employer-question',
        text: 'Where does Ava work now?',
        query: 'current_employer(ava, Company)',
        answerColumns: ['Company'],
      },
    ],
  },
  {
    id: 'honest_abstention',
    tags: ['abstention', 'unknown'],
    events: [
      {
        id: 'known-beverage',
        at: '2026-06-10T09:00:00.000Z',
        text: 'Ava likes coffee.',
        clauses: 'likes_beverage(ava, coffee).',
        trust: 'accepted',
      },
    ],
    questions: [
      {
        id: 'unknown-gift-question',
        text: 'What gift does Ava want?',
        query: 'prefers_gift(ava, Gift)',
        answerColumns: ['Gift'],
      },
    ],
  },
  {
    id: 'explicit_trust',
    tags: ['trust', 'tentative', 'authority'],
    events: [
      {
        id: 'accepted-color',
        at: '2026-06-20T09:00:00.000Z',
        text: 'Rahul’s accepted favorite color is green.',
        clauses: 'favorite_color(rahul, green).',
        trust: 'accepted',
      },
      {
        id: 'tentative-color',
        at: '2026-06-21T09:00:00.000Z',
        text: 'A tentative note says Rahul’s favorite color may be blue.',
        clauses: 'favorite_color(rahul, blue).',
        trust: 'tentative',
      },
    ],
    questions: [
      {
        id: 'accepted-color-question',
        text: 'What is Rahul’s accepted favorite color?',
        query: 'favorite_color(rahul, Color)',
        answerColumns: ['Color'],
      },
      {
        id: 'possible-color-question',
        text: 'What might Rahul’s favorite color be?',
        query: 'favorite_color(rahul, Color)',
        answerColumns: ['Color'],
        includeTentative: true,
      },
    ],
  },
  {
    id: 'integrity_conflict',
    tags: ['integrity', 'contradiction', 'provenance'],
    events: [
      {
        id: 'active-zoe',
        at: '2026-07-01T09:00:00.000Z',
        text: 'Zoe is active.',
        clauses: 'active(zoe).',
        trust: 'accepted',
      },
      {
        id: 'suspended-zoe',
        at: '2026-07-02T09:00:00.000Z',
        text: 'Zoe is suspended.',
        clauses: 'suspended(zoe).',
        trust: 'accepted',
      },
      {
        id: 'account-conflict-rule',
        at: '2026-07-03T09:00:00.000Z',
        text: 'An account cannot be both active and suspended.',
        clauses: 'account_conflict(Person) :- active(Person), suspended(Person).',
        trust: 'accepted',
      },
    ],
    questions: [
      {
        id: 'account-conflict-question',
        text: 'Which account has conflicting status?',
        query: 'account_conflict(Person)',
        answerColumns: ['Person'],
      },
    ],
  },
];

export const MEMORY_STACK_LABELS: MemoryStackLabel[] = [
  {
    caseId: 'direct_fact_at_scale',
    questionId: 'direct-employer-question',
    expectedStatus: 'answered',
    expectedRows: [[atom('acme')]],
    relevantEventIds: ['direct-employer'],
  },
  {
    caseId: 'multi_hop_rule',
    questionId: 'atlas-collaborator-question',
    expectedStatus: 'answered',
    expectedRows: [[atom('maya')]],
    relevantEventIds: ['atlas-owner', 'atlas-contributor', 'collaborator-rule'],
  },
  {
    caseId: 'recursive_reasoning',
    questionId: 'alice-descendants-question',
    expectedStatus: 'answered',
    expectedRows: [[atom('bob')], [atom('carol')], [atom('dan')]],
    relevantEventIds: [
      'parent-alice-bob',
      'parent-bob-carol',
      'parent-carol-dan',
      'ancestor-rules',
    ],
  },
  {
    caseId: 'temporal_update',
    questionId: 'current-employer-question',
    expectedStatus: 'answered',
    expectedRows: [[atom('initech')]],
    relevantEventIds: [
      'employment-old',
      'employment-new',
      'current-employment-rules',
    ],
  },
  {
    caseId: 'honest_abstention',
    questionId: 'unknown-gift-question',
    expectedStatus: 'no_match',
    expectedRows: [],
    relevantEventIds: [],
  },
  {
    caseId: 'explicit_trust',
    questionId: 'accepted-color-question',
    expectedStatus: 'answered',
    expectedRows: [[atom('green')]],
    relevantEventIds: ['accepted-color'],
  },
  {
    caseId: 'explicit_trust',
    questionId: 'possible-color-question',
    expectedStatus: 'answered',
    expectedRows: [[atom('green')], [atom('blue')]],
    relevantEventIds: ['accepted-color', 'tentative-color'],
  },
  {
    caseId: 'integrity_conflict',
    questionId: 'account-conflict-question',
    expectedStatus: 'answered',
    expectedRows: [[atom('zoe')]],
    relevantEventIds: ['active-zoe', 'suspended-zoe', 'account-conflict-rule'],
  },
];

export const MEMORY_STACK_SUITE = {
  id: 'rembero-structured-memory',
  version: '1.0.0',
} as const;
