import { createHash } from 'node:crypto';
import {
  type Clause,
  canonicalKey,
  isIntegrityConstraint,
  serializeClause,
} from '../engine/index.js';
import type {
  MemorySource,
  MemoryStore,
  RecordedSnapshotMetadata,
} from '../store/store.js';
import {
  checkIntegrity,
  type IntegrityCheckResult,
} from './integrity.js';
import {
  auditKnowledgeRules,
  type RuleAuditResult,
} from './rule-audit.js';
import {
  runKnowledgeChecks,
  type KnowledgeCheckSuite,
  type KnowledgeCheckSuiteResult,
} from './checks.js';
import {
  buildEntityResolver,
  type EntityAlias,
  type EntityIdentityMode,
  type EntityPosition,
} from './identity.js';
import {
  decodeTentativeDeclaration,
  isTentativeDeclaration,
  type TrustViewMode,
} from './trust.js';

export const MAX_KNOWLEDGE_HEALTH_FINDINGS = 4_096;
export const MAX_KNOWLEDGE_HEALTH_UNSOURCED = 1_000;

export type KnowledgeHealthStatus = 'healthy' | 'review' | 'violations';
export type KnowledgeHealthSeverity = 'error' | 'warning';
export type KnowledgeHealthCode =
  | 'integrity_violations'
  | 'rule_warnings'
  | 'knowledge_checks_failed'
  | 'coverage_failed'
  | 'tentative_claims_pending'
  | 'missing_provenance';

export interface KnowledgeHealthFinding {
  id: string;
  severity: KnowledgeHealthSeverity;
  code: KnowledgeHealthCode;
  message: string;
  count: number;
}

export interface KnowledgeHealthOptions {
  namespaces?: string[] | '*';
  recordedSequence?: number;
  entityIdentity?: EntityIdentityMode;
  trustMode?: TrustViewMode;
  checkSuite?: KnowledgeCheckSuite | string;
  proofLimit?: number;
  maxViolations?: number;
}

export interface KnowledgeHealthResult {
  status: KnowledgeHealthStatus;
  stateDigest: string;
  namespaces: string[];
  clauseCount: number;
  sourceWitnessCount: number;
  findings: KnowledgeHealthFinding[];
  integrity: IntegrityCheckResult;
  rules: RuleAuditResult;
  checks?: KnowledgeCheckSuiteResult;
  trust: {
    pendingTentativeCount: number;
    pendingClauses: string[];
  };
  identity: {
    aliasCount: number;
    positionCount: number;
    aliases: EntityAlias[];
    positions: EntityPosition[];
  };
  provenance: {
    sourcedClauseCount: number;
    unsourcedClauseCount: number;
    sourceCoveragePercent: number;
    unsourced: Array<{ namespace: string; clause: string }>;
  };
  recordedSnapshot?: RecordedSnapshotMetadata;
  trustMode?: TrustViewMode;
}

interface HealthSnapshot {
  namespaces: string[];
  clauses: Clause[];
  clausesByNamespace: Map<string, Clause[]>;
  sources: Map<string, MemorySource[]>;
  recordedSnapshot?: RecordedSnapshotMetadata;
}

function recordedClausesByNamespace(
  namespaces: string[],
  clauses: Clause[],
  sources: Map<string, MemorySource[]>
): Map<string, Clause[]> {
  const result = new Map(namespaces.map((namespace) => [namespace, [] as Clause[]]));
  for (const clause of clauses) {
    const sourceNamespaces = new Set(
      (sources.get(canonicalKey(clause)) ?? []).map((source) => source.namespace)
    );
    for (const namespace of namespaces) {
      if (sourceNamespaces.has(namespace)) result.get(namespace)!.push(clause);
    }
  }
  return result;
}

function snapshotFor(
  store: MemoryStore,
  namespaces: string[] | '*',
  sequence: number | undefined
): HealthSnapshot {
  if (sequence === undefined) {
    const snapshot = store.knowledgeSnapshot(namespaces);
    return {
      namespaces: snapshot.namespaces,
      clauses: snapshot.clauses,
      clausesByNamespace: snapshot.clausesByNamespace,
      sources: snapshot.sources,
    };
  }
  const snapshot = store.recordedSnapshot(namespaces, sequence);
  return {
    namespaces: snapshot.namespaces,
    clauses: snapshot.clauses,
    clausesByNamespace: recordedClausesByNamespace(
      snapshot.namespaces,
      snapshot.clauses,
      snapshot.sources
    ),
    sources: snapshot.sources,
    recordedSnapshot: {
      sequence: snapshot.sequence,
      journalEntries: snapshot.journalEntries,
      namespaces: snapshot.namespaces,
    },
  };
}

function stateDigest(snapshot: HealthSnapshot): string {
  const sourceEntries = [...snapshot.sources]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, sources]) => [
      key,
      [...sources].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
    ]);
  return createHash('sha256')
    .update(
      JSON.stringify({
        namespaces: snapshot.namespaces,
        clauses: snapshot.namespaces.map((namespace) => [
          namespace,
          (snapshot.clausesByNamespace.get(namespace) ?? []).map(canonicalKey),
        ]),
        sources: sourceEntries,
      })
    )
    .digest('hex');
}

function finding(
  severity: KnowledgeHealthSeverity,
  code: KnowledgeHealthCode,
  message: string,
  count: number
): KnowledgeHealthFinding {
  return {
    id: `health:${createHash('sha256')
      .update(JSON.stringify([severity, code, count]))
      .digest('hex')}`,
    severity,
    code,
    message,
    count,
  };
}

/** Build one immutable, deterministic health report over current or recorded knowledge. */
export function inspectKnowledgeHealth(
  store: MemoryStore,
  options: KnowledgeHealthOptions = {}
): KnowledgeHealthResult {
  const snapshot = snapshotFor(
    store,
    options.namespaces ?? '*',
    options.recordedSequence
  );
  const shared = {
    ...(options.entityIdentity === undefined
      ? {}
      : { entityIdentity: options.entityIdentity }),
    ...(options.trustMode === undefined || options.trustMode === 'accepted'
      ? {}
      : { trustMode: options.trustMode }),
    ...(options.proofLimit === undefined
      ? {}
      : { maxProofsPerRow: options.proofLimit }),
  };
  const integrity = checkIntegrity(
    snapshot.clauses,
    snapshot.sources,
    {
      ...shared,
      ...(options.maxViolations === undefined
        ? {}
        : { maxViolations: options.maxViolations }),
    }
  );
  const rules = auditKnowledgeRules(snapshot.clauses, snapshot.sources, shared);
  const checks = options.checkSuite === undefined
    ? undefined
    : runKnowledgeChecks(
        snapshot.clauses,
        snapshot.sources,
        options.checkSuite,
        shared
      );
  const resolver = buildEntityResolver(snapshot.clauses, snapshot.sources);
  const aliases = resolver.aliases();
  const positions = resolver.positions();
  const pendingClauses = snapshot.clauses
    .filter(isTentativeDeclaration)
    .map((clause) => decodeTentativeDeclaration(clause))
    .filter((clause): clause is Clause => clause !== undefined)
    .map(serializeClause)
    .sort();

  const unsourced: Array<{ namespace: string; clause: string }> = [];
  let sourcedClauseCount = 0;
  for (const namespace of snapshot.namespaces) {
    for (const clause of snapshot.clausesByNamespace.get(namespace) ?? []) {
      const sources = snapshot.sources.get(canonicalKey(clause)) ?? [];
      if (sources.some((source) => source.namespace === namespace)) {
        sourcedClauseCount++;
      } else {
        if (unsourced.length >= MAX_KNOWLEDGE_HEALTH_UNSOURCED) {
          throw new Error(
            `knowledge health exceeds ${MAX_KNOWLEDGE_HEALTH_UNSOURCED} unsourced clauses`
          );
        }
        unsourced.push({ namespace, clause: serializeClause(clause) });
      }
    }
  }
  const findings: KnowledgeHealthFinding[] = [];
  const addFinding = (value: KnowledgeHealthFinding) => {
    findings.push(value);
    if (findings.length > MAX_KNOWLEDGE_HEALTH_FINDINGS) {
      throw new Error(
        `knowledge health exceeds ${MAX_KNOWLEDGE_HEALTH_FINDINGS} findings`
      );
    }
  };
  if (integrity.violationCount > 0) {
    addFinding(
      finding(
        'error',
        'integrity_violations',
        `${integrity.violationCount} integrity violation(s) require resolution`,
        integrity.violationCount
      )
    );
  }
  if (rules.warningCount > 0) {
    addFinding(
      finding(
        'warning',
        'rule_warnings',
        `${rules.warningCount} deterministic rule warning(s) require review`,
        rules.warningCount
      )
    );
  }
  if ((checks?.failedCount ?? 0) > 0) {
    addFinding(
      finding(
        'warning',
        'knowledge_checks_failed',
        `${checks!.failedCount} knowledge regression check(s) failed`,
        checks!.failedCount
      )
    );
  }
  if (checks !== undefined && !checks.coveragePassed) {
    addFinding(
      finding(
        'warning',
        'coverage_failed',
        `semantic rule coverage ${checks.coverage.percent}% is below ${checks.coverage.minimumPercent}%`,
        checks.coverage.uncoveredRules
      )
    );
  }
  if (pendingClauses.length > 0) {
    addFinding(
      finding(
        'warning',
        'tentative_claims_pending',
        `${pendingClauses.length} tentative claim(s) await review`,
        pendingClauses.length
      )
    );
  }
  if (unsourced.length > 0) {
    addFinding(
      finding(
        'warning',
        'missing_provenance',
        `${unsourced.length} current clause(s) have no durable source witness`,
        unsourced.length
      )
    );
  }
  findings.sort(
    (left, right) =>
      (left.severity === right.severity ? 0 : left.severity === 'error' ? -1 : 1) ||
      left.code.localeCompare(right.code)
  );
  const clauseCount = snapshot.namespaces.reduce(
    (total, namespace) =>
      total + (snapshot.clausesByNamespace.get(namespace)?.length ?? 0),
    0
  );
  const sourceWitnessCount = [...snapshot.sources.values()].reduce(
    (total, sources) => total + sources.length,
    0
  );
  const status: KnowledgeHealthStatus = integrity.violationCount > 0
    ? 'violations'
    : findings.length > 0
      ? 'review'
      : 'healthy';
  return {
    status,
    stateDigest: stateDigest(snapshot),
    namespaces: [...snapshot.namespaces],
    clauseCount,
    sourceWitnessCount,
    findings,
    integrity,
    rules,
    ...(checks === undefined ? {} : { checks }),
    trust: {
      pendingTentativeCount: pendingClauses.length,
      pendingClauses,
    },
    identity: {
      aliasCount: aliases.length,
      positionCount: positions.length,
      aliases,
      positions,
    },
    provenance: {
      sourcedClauseCount,
      unsourcedClauseCount: unsourced.length,
      sourceCoveragePercent:
        clauseCount === 0 ? 100 : Math.round((sourcedClauseCount / clauseCount) * 100),
      unsourced,
    },
    ...(snapshot.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: snapshot.recordedSnapshot }),
    ...(options.trustMode === undefined || options.trustMode === 'accepted'
      ? {}
      : { trustMode: options.trustMode }),
  };
}
