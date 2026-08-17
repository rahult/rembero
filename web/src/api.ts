export type NavigationView = 'ask' | 'knowledge' | 'graph' | 'rules';
export type SearchKind = 'fact' | 'rule' | 'constraint';
export type HealthTone = 'healthy' | 'review' | 'violations';

export interface ProfileSummary {
  workspaceLabel: string;
  personaLabel: string;
  storageLabel: string;
}

export interface AskPreset {
  id: string;
  label: string;
  question: string;
}

export interface MemoryPulse {
  factCount: number;
  ruleCount: number;
  sourceCoveragePercent: number;
  healthTone: HealthTone;
  healthLabel: string;
  findingCount: number;
}

export interface SourceItem {
  id: string;
  label: string;
  detail: string;
  dateLabel: string;
  namespace: string;
}

export interface ProofClaim {
  id: string;
  clause: string;
  supportingSourceIds: string[];
}

export interface RecentMemoryItem {
  id: string;
  title: string;
  detail: string;
  dateLabel: string;
  clause?: string;
  sourceLabel?: string;
}

export interface KnowledgeResultItem {
  id: string;
  rank: number;
  kind: SearchKind;
  clause: string;
  score: number;
  reasonSummary: string;
  sourcePreview: string;
}

export interface RuleListItem {
  id: string;
  clause: string;
  summary: string;
  status: 'stable' | 'review';
  sourceLabel: string;
}

export interface GraphNodeView {
  id: string;
  label: string;
  aliases: string[];
  emphasis: boolean;
}

export interface GraphLinkView {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface GraphRelationship {
  id: string;
  clause: string;
  label: string;
  left: string;
  right?: string;
}

export interface GraphData {
  focus: string | null;
  nodes: GraphNodeView[];
  links: GraphLinkView[];
  relationships: GraphRelationship[];
}

export interface BootstrapResponse {
  profile: ProfileSummary;
  memoryPulse: MemoryPulse;
  askPresets: AskPreset[];
  recentMemory: RecentMemoryItem[];
  knowledgeHighlights: KnowledgeResultItem[];
  graph: GraphData;
  rules: RuleListItem[];
  healthFindings: string[];
}

export interface AskResponse {
  question: string;
  query: string;
  answer: string;
  status: string;
  claims: ProofClaim[];
  sources: SourceItem[];
  relatedKnowledge: KnowledgeResultItem[];
  graph: GraphData;
}

export interface SearchResponse {
  text: string;
  kinds: SearchKind[];
  status: 'matches' | 'no_match';
  results: KnowledgeResultItem[];
}

export interface GraphResponse {
  focus: string | null;
  graph: GraphData;
}

export interface MemoryMutationResponse {
  ok: boolean;
  message: string;
}

interface MemorySourceRecord {
  namespace: string;
  opId: string;
  ts: string;
  text?: string;
}

const DEFAULT_PRESETS: AskPreset[] = [
  {
    id: 'owners',
    label: 'Who owns Atlas?',
    question: 'Who owns Atlas?',
  },
  {
    id: 'northstar',
    label: 'What is Northstar?',
    question: 'What is Northstar?',
  },
  {
    id: 'contributors',
    label: 'Who worked with Maya?',
    question: 'Who worked with Maya?',
  },
  {
    id: 'rules',
    label: 'Show rules about projects',
    question: 'Show rules about projects',
  },
];

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function requestJson<TPayload>(
  path: string,
  init?: RequestInit
): Promise<TPayload> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const payload = JSON.parse(text) as { message?: unknown };
      if (typeof payload.message === 'string') message = payload.message;
    } catch {
      // Preserve a non-JSON server response verbatim.
    }
    throw new ApiError(message || `Request failed for ${path}`, response.status);
  }
  return (await response.json()) as TPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatPredicate(value: string): string {
  return titleCase(value.replaceAll('/', ' '));
}

export function formatClause(predicate: string, values: Array<string | number>): string {
  return `${predicate}(${values.map((value) => String(value)).join(', ')})`;
}

function formatDateLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'Recent';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function entitySignature(valueType: unknown, value: unknown): string {
  const kind = valueType === 'number' ? 'number' : 'atom';
  return `${kind}:${String(value)}`;
}

function normalizeSourceItem(record: unknown, index: number): SourceItem {
  const source = isRecord(record) ? record : {};
  const namespace = asString(source.namespace, 'memory');
  const detail = asString(source.text, `${namespace}/${asString(source.opId, 'source')}`);
  const opId = asString(source.opId, String(index));
  const knownLabels: Record<string, string> = {
    'web-demo-atlas-session-v1': 'Atlas planning session',
    'web-demo-directory-v1': 'Personal directory',
    'web-demo-rules-v1': 'Reviewed personal rules',
  };
  return {
    id: `${namespace}:${opId || index}`,
    label:
      knownLabels[opId] ?? (detail.length > 72 ? `${detail.slice(0, 69)}...` : detail),
    detail,
    dateLabel: formatDateLabel(source.ts),
    namespace,
  };
}

function normalizeKnowledgeItem(record: unknown, index: number): KnowledgeResultItem {
  const item = isRecord(record) ? record : {};
  const reasons = asArray<Record<string, unknown>>(item.reasons);
  const sources = asArray<Record<string, unknown>>(item.sources);
  const reasonSummary = reasons
    .map((reason) => titleCase(asString(reason.kind).replaceAll('_', ' ')))
    .filter(Boolean)
    .slice(0, 2)
    .join(' • ');
  return {
    id: asString(item.id, `knowledge-${index}`),
    rank: asNumber(item.rank, index + 1),
    kind: (asString(item.kind, 'fact') as SearchKind),
    clause: asString(item.clause, 'No clause provided.'),
    score: asNumber(item.score),
    reasonSummary: reasonSummary || 'Local lexical match',
    sourcePreview: asString(sources[0]?.text, asString(sources[0]?.namespace, 'Local memory')),
  };
}

function normalizeRecentMemory(record: unknown, index: number): RecentMemoryItem {
  const item = isRecord(record) ? record : {};
  return {
    id: asString(item.id, `recent-${index}`),
    title: asString(item.title, asString(item.entity, 'Memory')),
    detail: asString(item.detail, asString(item.summary, 'Stored in local-first memory.')),
    dateLabel: asString(item.dateLabel, formatDateLabel(item.ts)),
    ...(typeof item.clause === 'string' ? { clause: item.clause } : {}),
    ...(typeof item.sourceLabel === 'string' ? { sourceLabel: item.sourceLabel } : {}),
  };
}

function normalizeRuleItem(record: unknown, index: number): RuleListItem {
  const item = isRecord(record) ? record : {};
  const clause = asString(item.clause, asString(item.rule, ''));
  const findingCount = asNumber(item.findingCount);
  const sources = asArray<Record<string, unknown>>(item.sources);
  return {
    id: asString(item.id, `rule-${index}`),
    clause: clause || 'No rule clause available.',
    summary:
      asString(item.summary) ||
      asString(item.message) ||
      (findingCount > 0 ? `${findingCount} audit note(s)` : 'Deterministic rule'),
    status:
      asString(item.status) === 'review' || findingCount > 0 ? 'review' : 'stable',
    sourceLabel: asString(
      item.sourceLabel,
      asString(sources[0]?.namespace, 'Knowledge rule')
    ),
  };
}

function graphPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  if (isRecord(payload.graph)) return payload.graph;
  return payload;
}

function normalizeGraph(payload: unknown, preferredFocus?: string | null): GraphData {
  const root = graphPayload(payload);
  const selection = isRecord(root.selection) ? root.selection : {};
  const nodes = asArray<Record<string, unknown>>(root.nodes);
  const entityNodes = nodes.filter((node) => node.kind === 'entity');
  const claimNodes = nodes.filter((node) => node.kind === 'claim');
  const entityBySignature = new Map<
    string,
    { id: string; label: string; aliases: string[] }
  >();

  for (const node of entityNodes) {
    const label = String(node.value ?? '');
    entityBySignature.set(entitySignature(node.valueType, node.value), {
      id: asString(node.id, label),
      label,
      aliases: asArray<Record<string, unknown>>(node.aliases).map((alias) =>
        asString(alias.alias)
      ),
    });
  }

  const fallbackFocus = asString(selection.resolvedFocus, asString(selection.focus));
  const focusCandidate = preferredFocus ?? fallbackFocus;
  const focus = focusCandidate || entityNodes[0]?.value?.toString() || null;
  const relationships: GraphRelationship[] = [];
  const linkMap = new Map<string, GraphLinkView>();

  for (const [index, claim] of claimNodes.entries()) {
    const predicate = asString(claim.predicate, 'relates_to');
    const values = asArray<string | number>(claim.values);
    const entityValues = values
      .map((value) =>
        entityBySignature.get(entitySignature(typeof value === 'number' ? 'number' : 'atom', value))
      )
      .filter((value): value is { id: string; label: string; aliases: string[] } => value !== undefined);
    const clause = formatClause(predicate, values);
    const left = entityValues[0]?.label ?? String(values[0] ?? focus ?? 'memory');
    const right = entityValues[1]?.label;
    relationships.push({
      id: asString(claim.id, `relationship-${index}`),
      clause,
      label: formatPredicate(predicate),
      left,
      ...(right === undefined ? {} : { right }),
    });
    if (entityValues.length >= 2) {
      const [first, second] = entityValues;
      const key = `${first.id}:${second.id}:${predicate}`;
      if (!linkMap.has(key)) {
        linkMap.set(key, {
          id: key,
          from: first.id,
          to: second.id,
          label: predicate.replaceAll('_', ' '),
        });
      }
    }
  }

  const normalizedNodes = [...entityBySignature.values()]
    .sort((left, right) => {
      if (left.label === focus) return -1;
      if (right.label === focus) return 1;
      return left.label.localeCompare(right.label);
    })
    .map((node) => ({
      id: node.id,
      label: node.label,
      aliases: node.aliases,
      emphasis: node.label === focus,
    }));

  return {
    focus,
    nodes: normalizedNodes,
    links: [...linkMap.values()],
    relationships,
  };
}

function collectGraphSources(payload: unknown): SourceItem[] {
  const root = graphPayload(payload);
  const nodes = asArray<Record<string, unknown>>(root.nodes);
  const seen = new Set<string>();
  const sources: SourceItem[] = [];
  for (const node of nodes) {
    const rawSources = asArray<MemorySourceRecord>(node.sources);
    for (const source of rawSources) {
      const item = normalizeSourceItem(source, sources.length);
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      sources.push(item);
    }
  }
  return sources;
}

function normalizeBootstrap(payload: unknown): BootstrapResponse {
  const root = isRecord(payload) ? payload : {};
  const health = isRecord(root.health) ? root.health : {};
  const healthStatus = asString(root.memoryPulse && isRecord(root.memoryPulse) ? root.memoryPulse.healthTone : health.status, 'healthy') as HealthTone;
  const topology = isRecord(health.rules) && isRecord(health.rules.topology)
    ? health.rules.topology
    : {};
  const ruleNodes =
    asArray(root.rules).length > 0
      ? asArray(root.rules)
      : asArray(topology.rules);
  const graph = normalizeGraph(root.graph, null);
  const knowledgeHighlights = asArray(root.knowledgeHighlights).map(normalizeKnowledgeItem);
  const recentMemory =
    asArray(root.recentMemory).length > 0
      ? asArray(root.recentMemory).map(normalizeRecentMemory)
      : collectGraphSources(root.graph).slice(0, 3).map((source, index) => ({
          id: `source-memory-${index}`,
          title: source.namespace === 'memory' ? 'Memory source' : titleCase(source.namespace),
          detail: source.detail,
          dateLabel: source.dateLabel,
          sourceLabel: source.namespace,
        }));
  const healthFindings = asArray<Record<string, unknown>>(health.findings)
    .slice(0, 4)
    .map((finding) => asString(finding.message))
    .filter(Boolean);
  return {
    profile: {
      workspaceLabel: asString(root.workspaceLabel, 'Rembero'),
      personaLabel:
        asString(isRecord(root.profile) ? root.profile.personaLabel : undefined) ||
        asString(isRecord(root.profile) ? root.profile.name : undefined) ||
        'Personal',
      storageLabel:
        asString(isRecord(root.profile) ? root.profile.storageLabel : undefined) ||
        'Local-first',
    },
    memoryPulse: {
      factCount:
        asNumber(isRecord(root.memoryPulse) ? root.memoryPulse.factCount : undefined) ||
        asNumber(health.clauseCount),
      ruleCount:
        asNumber(isRecord(root.memoryPulse) ? root.memoryPulse.ruleCount : undefined) ||
        asNumber(topology.ruleCount) ||
        ruleNodes.length,
      sourceCoveragePercent:
        asNumber(
          isRecord(root.memoryPulse) ? root.memoryPulse.sourceCoveragePercent : undefined
        ) || asNumber(isRecord(health.provenance) ? health.provenance.sourceCoveragePercent : undefined, 100),
      healthTone: healthStatus,
      healthLabel:
        asString(isRecord(root.memoryPulse) ? root.memoryPulse.healthLabel : undefined) ||
        titleCase(healthStatus),
      findingCount: healthFindings.length,
    },
    askPresets:
      asArray(root.askPresets).length > 0
        ? asArray<Record<string, unknown>>(root.askPresets).map((preset, index) => ({
            id: asString(preset.id, `preset-${index}`),
            label: asString(preset.label, asString(preset.question, `Preset ${index + 1}`)),
            question: asString(preset.question, ''),
          }))
        : DEFAULT_PRESETS,
    recentMemory,
    knowledgeHighlights,
    graph,
    rules: ruleNodes.map(normalizeRuleItem),
    healthFindings,
  };
}

function normalizeAsk(payload: unknown, question: string): AskResponse {
  const root = isRecord(payload) ? payload : {};
  const explanation = isRecord(root.explanation) ? root.explanation : {};
  const evidence = isRecord(root.evidence) ? root.evidence : {};
  const graph = normalizeGraph(explanation.graph ?? root.graph, null);
  const sources = collectGraphSources(explanation.graph ?? root.graph);
  const related = isRecord(root.relatedKnowledge) ? root.relatedKnowledge : {};
  const evidenceClaims = asArray<string>(evidence.claims);
  const claims = evidenceClaims.length > 0
    ? evidenceClaims.map((clause, index) => ({
        id: `evidence-claim-${index}`,
        clause,
        supportingSourceIds: [],
      }))
    : asArray<Record<string, unknown>>(graphPayload(explanation.graph).nodes)
        .filter((node) => node.kind === 'claim' && node.derived !== true)
        .map((node, index) => {
          const values = asArray<string | number>(node.values);
          return {
            id: asString(node.id, `claim-${index}`),
            clause: formatClause(asString(node.predicate, 'claim'), values),
            supportingSourceIds: asArray(node.sources).map((_, sourceIndex) =>
              `${asString(node.id, `claim-${index}`)}:${sourceIndex}`
            ),
          };
        });
  return {
    question,
    query: asString(root.query, question),
    answer: asString(root.answer, 'No answer returned.'),
    status: asString(root.status, 'answered'),
    claims,
    sources,
    relatedKnowledge: asArray(related.results).map(normalizeKnowledgeItem),
    graph,
  };
}

function normalizeSearch(
  payload: unknown,
  text: string,
  kinds: SearchKind[]
): SearchResponse {
  const root = isRecord(payload) ? payload : {};
  return {
    text: asString(root.text, text),
    kinds,
    status: asString(root.status, 'no_match') as 'matches' | 'no_match',
    results: asArray(root.results).map(normalizeKnowledgeItem),
  };
}

export async function getBootstrap(): Promise<BootstrapResponse> {
  const payload = await requestJson<unknown>('/api/bootstrap');
  return normalizeBootstrap(payload);
}

export async function askMemory(input: {
  question: string;
  presetId?: string;
}): Promise<AskResponse> {
  const payload = await requestJson<unknown>('/api/ask', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return normalizeAsk(payload, input.question);
}

export async function createMemory(input: {
  subject: string;
  predicate: string;
  object: string;
  sourceText: string;
}): Promise<MemoryMutationResponse> {
  const payload = await requestJson<unknown>('/api/memory', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const root = isRecord(payload) ? payload : {};
  return {
    ok: true,
    message:
      asString(root.message) ||
      `${input.subject} ${input.predicate} ${input.object} stored in local memory.`,
  };
}

export async function searchKnowledge(input: {
  text: string;
  kinds?: SearchKind[];
}): Promise<SearchResponse> {
  const payload = await requestJson<unknown>('/api/search', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return normalizeSearch(payload, input.text, input.kinds ?? []);
}

export async function getGraph(focus?: string): Promise<GraphResponse> {
  const query = focus ? `?focus=${encodeURIComponent(focus)}` : '';
  const payload = await requestJson<unknown>(`/api/graph${query}`);
  const graph = normalizeGraph(payload, focus ?? null);
  return {
    focus: graph.focus,
    graph,
  };
}

export async function seedDemo(): Promise<MemoryMutationResponse> {
  const payload = await requestJson<unknown>('/api/seed', { method: 'POST' });
  const root = isRecord(payload) ? payload : {};
  return {
    ok: true,
    message: asString(root.message, 'Demo knowledge seeded.'),
  };
}
