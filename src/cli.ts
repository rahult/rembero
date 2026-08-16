#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { autoCaptureClaudeStop } from './autocapture/capture.js';
import {
  DEFAULT_AUTO_CAPTURE_DAILY_CAP,
  MANAGED_HOOK_MARKER,
  defaultClaudeSettingsPath,
  installClaudeHook,
  removeClaudeHook,
} from './autocapture/hooks.js';
import { DEFAULT_TRANSCRIPT_TAIL_BYTES } from './autocapture/transcript.js';
import { MAX_PROOFS_PER_ROW, serializeClause } from './engine/index.js';
import {
  entityIdentityFromEnv,
  integrityEnforcementFromEnv,
  loadEnv,
  recallSchemaPredicateLimitFromEnv,
  validTimeModeFromEnv,
} from './env.js';
import { clientFromEnv, lazyClientFromEnv } from './llm/client.js';
import { rememberText, recallQuestion } from './llm/pipeline.js';
import { MAX_RECALL_SCHEMA_PREDICATES } from './llm/schema.js';
import { MAX_INTEGRITY_VIOLATIONS } from './knowledge/integrity.js';
import {
  IntegrityViolationError,
  type IntegrityEnforcementOptions,
} from './knowledge/enforcement.js';
import type { EntityIdentityMode } from './knowledge/identity.js';
import {
  MAX_GRAPH_NEIGHBOR_DEPTH,
  MAX_GRAPH_NODE_ID_BYTES,
  MAX_GRAPH_RESULT_ROW,
  type ExplanationGraphSelector,
} from './knowledge/graph-navigation.js';
import { serveStdio } from './mcp/server.js';
import {
  checkIntegrityTool,
  assertFactsTool,
  explainQueryTool,
  forgetTool,
  historyTool,
  listMemoriesTool,
  queryTool,
} from './mcp/tools.js';
import {
  MAX_HISTORY_EVENTS,
  MAX_OPERATION_ID_BYTES,
  MemoryStore,
  IncompleteHistoryError,
  OperationConflictError,
  type ValidTimeMode,
} from './store/store.js';
import {
  MAX_INPUT_BYTES,
  assertBoundedOutput,
  llmNamespaceAllowlistFromEnv,
  stringifyBoundedResult,
} from './safety.js';
import { buildSqliteExtension, openDatalogDatabase } from './sqlite/extension.js';

const USAGE = `rembero — logic-based memory for chats and agents

Usage:
  rembero serve                          Start the MCP server on stdio
  rembero remember <text>                Extract facts from text and store them
  rembero remember --batch               Auto-capture from Claude Stop-hook JSON on stdin
  rembero recall <question>              Answer a question from memory
  rembero recall-explain <question>      Recall with proofs, sources, and a graph
  rembero query <datalog>                Run a raw Datalog query
  rembero assert <datalog>               Store raw Datalog facts, rules, or constraints
  rembero explain <datalog>              Query with proofs, sources, and a knowledge graph
  rembero check                          Check explicit integrity constraints with evidence
  rembero forget <pattern>               Retract facts matching a pattern
  rembero history <pattern>              Show a fact's deterministic life story
  rembero list                           List stored memories
  rembero review                         Review recent auto-captured facts
  rembero init-hooks                     Install the opt-in Claude Stop hook
  rembero init-hooks --remove            Remove only Rembero's managed hook
  rembero export                         Print all memories as portable Datalog
  rembero import <ns> <file>             Load clauses from a .dl file into a namespace
  rembero sqlite-build                   Compile the loadable SQLite extension
  rembero sqlite-sql <db> <rule>         Compile a Datalog rule against a SQLite database
  rembero sqlite-query <db> <program>    Execute a Datalog program against a SQLite database
  rembero sqlite-explain <db> <program>  Execute with one derivation proof per result

Options:
  -n, --namespace <ns>     Namespace to write to / read from (default: "default")
      --namespaces <a,b|*> Namespaces to search for recall/query/check/list/history
      --valid-time-mode <mode>  Supersession: delete (default) or archive_until
      --schema-predicate-limit <n>  Detailed recall predicates (default: 32; max: 256)
      --proof-limit <n>    Proof witnesses per explain result (default: 1; max: ${MAX_PROOFS_PER_ROW})
      --max-violations <n> Maximum integrity violations (default: 1000; max: ${MAX_INTEGRITY_VIOLATIONS})
      --integrity-mode <mode>  Write guard: off, strict, or no_new_violations
      --integrity-namespaces <a,b|*>  Knowledge view governed by write enforcement
      --entity-identity <mode>  Read projection: off (default) or canonical
      --op-id <id>        Stable idempotency key for assert, forget, or import retries
      --as-of-sequence <n> Read the knowledge view after global journal entry n (0 = empty)
      --graph-result <n>  Export the complete support graph for result row n
      --graph-support <node-id>  Export the support closure for one graph node
      --graph-neighbors <node-id>  Export a bounded undirected neighborhood
      --graph-depth <n>   Neighborhood depth (default: 1; max: ${MAX_GRAPH_NEIGHBOR_DEPTH})
      --limit <n>          History event limit (maximum: 1000)
      --extension <path>   Path to the compiled Rembero SQLite extension
      --daily-cap <n>      Max auto-capture attempts per namespace/UTC day (default: 10)
      --tail-bytes <n>     Transcript tail bytes sent for extraction (default: 24576)
      --days <n>           Auto-capture review window (default: 7)
      --forget <n,...>     Prune numbered facts shown by review
      --settings <path>    Claude settings JSON (default: ~/.claude/settings.json)
      --json               Emit machine-readable batch/review/history output
`;

interface ParsedArgs {
  positional: string[];
  namespace?: string;
  namespaces?: string[] | '*';
  extensionPath?: string;
  batch: boolean;
  json: boolean;
  remove: boolean;
  dailyCap?: string;
  tailBytes?: string;
  days?: string;
  forget?: string;
  settingsPath?: string;
  managedBy?: string;
  validTimeMode?: string;
  schemaPredicateLimit?: string;
  proofLimit?: string;
  maxViolations?: string;
  integrityMode?: string;
  integrityNamespaces?: string[] | '*';
  entityIdentity?: string;
  opId?: string;
  graphResult?: string;
  graphSupport?: string;
  graphNeighbors?: string;
  graphDepth?: string;
  limit?: string;
  asOfSequence?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], batch: false, json: false, remove: false };
  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-n' || arg === '--namespace') {
      parsed.namespace = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--namespaces') {
      const value = valueAfter(i, arg);
      i += 1;
      parsed.namespaces = value === '*' ? '*' : value.split(',');
    } else if (arg === '--extension') {
      parsed.extensionPath = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--batch') {
      parsed.batch = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--remove') {
      parsed.remove = true;
    } else if (arg === '--daily-cap') {
      parsed.dailyCap = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--tail-bytes') {
      parsed.tailBytes = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--valid-time-mode') {
      parsed.validTimeMode = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--schema-predicate-limit') {
      parsed.schemaPredicateLimit = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--proof-limit') {
      parsed.proofLimit = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--max-violations') {
      parsed.maxViolations = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--integrity-mode') {
      parsed.integrityMode = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--integrity-namespaces') {
      const value = valueAfter(i, arg);
      i += 1;
      parsed.integrityNamespaces = value === '*' ? '*' : value.split(',');
    } else if (arg === '--entity-identity') {
      parsed.entityIdentity = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--op-id') {
      parsed.opId = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--graph-result') {
      parsed.graphResult = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--graph-support') {
      parsed.graphSupport = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--graph-neighbors') {
      parsed.graphNeighbors = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--graph-depth') {
      parsed.graphDepth = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--limit') {
      parsed.limit = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--as-of-sequence') {
      parsed.asOfSequence = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--days') {
      parsed.days = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--forget') {
      parsed.forget = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--settings') {
      parsed.settingsPath = valueAfter(i, arg);
      i += 1;
    } else if (arg === '--managed-by') {
      parsed.managedBy = valueAfter(i, arg);
      i += 1;
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function integerOption(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

function validTimeModeOption(value: string | undefined): ValidTimeMode {
  if (value === undefined) return validTimeModeFromEnv();
  if (value === 'delete' || value === 'archive_until') return value;
  throw new Error("--valid-time-mode must be 'delete' or 'archive_until'");
}

function recallSchemaPredicateLimitOption(value: string | undefined): number {
  if (value === undefined) return recallSchemaPredicateLimitFromEnv();
  const parsed = integerOption(value, 0, 'recall schema predicate limit');
  if (parsed < 1 || parsed > MAX_RECALL_SCHEMA_PREDICATES) {
    throw new Error(
      `recall schema predicate limit must be from 1 to ${MAX_RECALL_SCHEMA_PREDICATES}`
    );
  }
  return parsed;
}

function proofLimitOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = integerOption(value, 0, 'proof limit');
  if (parsed < 1 || parsed > MAX_PROOFS_PER_ROW) {
    throw new Error(`proof limit must be from 1 to ${MAX_PROOFS_PER_ROW}`);
  }
  return parsed;
}

function maxViolationsOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = integerOption(value, 0, 'maximum integrity violations');
  if (parsed < 1 || parsed > MAX_INTEGRITY_VIOLATIONS) {
    throw new Error(
      `maximum integrity violations must be from 1 to ${MAX_INTEGRITY_VIOLATIONS}`
    );
  }
  return parsed;
}

function entityIdentityOption(
  value: string | undefined
): EntityIdentityMode | false | undefined {
  if (value === undefined) return entityIdentityFromEnv();
  if (value === 'off') return false;
  if (value === 'canonical') return value;
  throw new Error("--entity-identity must be 'off' or 'canonical'");
}

function graphNodeIdOption(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (Buffer.byteLength(value, 'utf8') > MAX_GRAPH_NODE_ID_BYTES) {
    throw new Error(`${label} exceeds ${MAX_GRAPH_NODE_ID_BYTES} bytes`);
  }
  return value;
}

function operationIdOption(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) throw new Error('operation id must not be empty');
  if (Buffer.byteLength(value, 'utf8') > MAX_OPERATION_ID_BYTES) {
    throw new Error(`operation id exceeds ${MAX_OPERATION_ID_BYTES} bytes`);
  }
  return value;
}

function graphSelectorOption(args: ParsedArgs): ExplanationGraphSelector | undefined {
  const selected = [args.graphResult, args.graphSupport, args.graphNeighbors].filter(
    (value) => value !== undefined
  );
  if (selected.length > 1) {
    throw new Error(
      '--graph-result, --graph-support, and --graph-neighbors are mutually exclusive'
    );
  }
  if (args.graphDepth !== undefined && args.graphNeighbors === undefined) {
    throw new Error('--graph-depth requires --graph-neighbors');
  }
  if (args.graphResult !== undefined) {
    const row = integerOption(args.graphResult, 0, 'graph result row');
    if (row < 1 || row > MAX_GRAPH_RESULT_ROW) {
      throw new Error(`graph result row must be from 1 to ${MAX_GRAPH_RESULT_ROW}`);
    }
    return { kind: 'result', row };
  }
  if (args.graphSupport !== undefined) {
    return {
      kind: 'support',
      nodeId: graphNodeIdOption(args.graphSupport, 'graph support node id'),
    };
  }
  if (args.graphNeighbors !== undefined) {
    const depth = integerOption(args.graphDepth, 1, 'graph neighbor depth');
    if (depth < 1 || depth > MAX_GRAPH_NEIGHBOR_DEPTH) {
      throw new Error(`graph neighbor depth must be from 1 to ${MAX_GRAPH_NEIGHBOR_DEPTH}`);
    }
    return {
      kind: 'neighbors',
      nodeId: graphNodeIdOption(args.graphNeighbors, 'graph neighbor node id'),
      depth,
    };
  }
  return undefined;
}

function integrityEnforcementOption(
  mode: string | undefined,
  namespaces: string[] | '*' | undefined,
  fallback: IntegrityEnforcementOptions | undefined,
  proofLimit: string | undefined,
  maxViolations: string | undefined,
  graphSelector: ExplanationGraphSelector | undefined
): IntegrityEnforcementOptions | false | undefined {
  const proofLimitValue = proofLimitOption(proofLimit);
  const maxViolationsValue = maxViolationsOption(maxViolations);
  if (mode === undefined) {
    if (
      (namespaces !== undefined ||
        proofLimitValue !== undefined ||
        maxViolationsValue !== undefined ||
        graphSelector !== undefined) &&
      fallback === undefined
    ) {
      throw new Error(
        'integrity write options require --integrity-mode or REMBERO_INTEGRITY_MODE'
      );
    }
    return fallback === undefined
      ? undefined
      : {
          ...fallback,
          ...(namespaces === undefined ? {} : { namespaces }),
          ...(proofLimitValue === undefined
            ? {}
            : { maxProofsPerRow: proofLimitValue }),
          ...(maxViolationsValue === undefined ? {} : { maxViolations: maxViolationsValue }),
          ...(graphSelector === undefined ? {} : { graphSelector }),
        };
  }
  if (mode === 'off') {
    if (
      namespaces !== undefined ||
      proofLimitValue !== undefined ||
      maxViolationsValue !== undefined ||
      graphSelector !== undefined
    ) {
      throw new Error("--integrity-mode 'off' cannot use integrity write options");
    }
    return false;
  }
  if (mode !== 'strict' && mode !== 'no_new_violations') {
    throw new Error("--integrity-mode must be 'off', 'strict', or 'no_new_violations'");
  }
  return {
    mode,
    ...(namespaces === undefined ? {} : { namespaces }),
    ...(proofLimitValue === undefined ? {} : { maxProofsPerRow: proofLimitValue }),
    ...(maxViolationsValue === undefined ? {} : { maxViolations: maxViolationsValue }),
    ...(graphSelector === undefined ? {} : { graphSelector }),
  };
}

async function readStdinBounded(maxBytes = MAX_INPUT_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`stdin exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function reviewSelections(raw: string | undefined, factCount: number): number[] {
  if (raw === undefined) return [];
  const values = raw.split(',').map((value) => value.trim());
  if (values.some((value) => !/^\d+$/.test(value))) {
    throw new Error('--forget must be a comma-separated list of review numbers');
  }
  const selected = [...new Set(values.map(Number))];
  const invalid = selected.find((value) => value < 1 || value > factCount);
  if (invalid !== undefined) {
    throw new Error(`review fact number ${invalid} is outside 1..${factCount}`);
  }
  return selected;
}

async function main(): Promise<void> {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const store = new MemoryStore();
  const graphSelector = graphSelectorOption(args);
  const operationId = operationIdOption(args.opId);
  const recordedSequence = args.asOfSequence === undefined
    ? undefined
    : integerOption(args.asOfSequence, 0, 'recorded snapshot sequence');
  const entityIdentitySetting = entityIdentityOption(args.entityIdentity);
  const entityIdentity = entityIdentitySetting === false
    ? undefined
    : entityIdentitySetting;
  const writeCommand = ['serve', 'remember', 'assert', 'forget', 'import', 'review'].includes(
    command ?? ''
  );
  const graphCommand = ['recall-explain', 'explain', 'check'].includes(command ?? '');
  if (graphSelector !== undefined && !writeCommand && !graphCommand) {
    throw new Error(
      'graph selection is available for recall-explain, explain, check, and integrity-guarded writes'
    );
  }
  if (
    operationId !== undefined &&
    !['assert', 'forget', 'import'].includes(command ?? '')
  ) {
    throw new Error('--op-id is available for assert, forget, and import');
  }
  if (
    recordedSequence !== undefined &&
    !['recall', 'recall-explain', 'query', 'explain', 'check', 'list'].includes(command ?? '')
  ) {
    throw new Error(
      '--as-of-sequence is available for recall, recall-explain, query, explain, check, and list'
    );
  }
  const rawIntegritySetting = integrityEnforcementOption(
    args.integrityMode,
    args.integrityNamespaces,
    integrityEnforcementFromEnv(),
    writeCommand ? args.proofLimit : undefined,
    writeCommand ? args.maxViolations : undefined,
    writeCommand ? graphSelector : undefined
  );
  const integritySetting =
    rawIntegritySetting === undefined || rawIntegritySetting === false
      ? rawIntegritySetting
      : {
          ...rawIntegritySetting,
          ...(entityIdentity === undefined ? {} : { entityIdentity }),
        };
  const integrityEnforcement =
    integritySetting === false ? undefined : integritySetting;
  const llmAllowedNamespaces = llmNamespaceAllowlistFromEnv();
  const text = args.positional.join(' ');
  const namespaces = args.namespaces ?? (args.namespace ? [args.namespace] : undefined);

  switch (command) {
    case 'serve':
      await serveStdio({
        store,
        llm: lazyClientFromEnv(),
        llmAllowedNamespaces,
        validTimeMode: validTimeModeOption(args.validTimeMode),
        recallSchemaPredicateLimit: recallSchemaPredicateLimitOption(
          args.schemaPredicateLimit
        ),
        integrityEnforcement: integritySetting,
        entityIdentity: entityIdentitySetting,
      });
      return; // keep process alive; transport owns stdio
    case 'remember': {
      if (args.batch) {
        if (args.managedBy !== undefined && args.managedBy !== MANAGED_HOOK_MARKER) {
          throw new Error('unrecognized auto-capture hook marker');
        }
        const rawHookInput = await readStdinBounded();
        const result = await autoCaptureClaudeStop(
          {
            store,
            llm: lazyClientFromEnv(),
            llmAllowedNamespaces,
            integrityEnforcement: integritySetting,
            entityIdentity: entityIdentitySetting,
          },
          rawHookInput,
          {
            namespace: args.namespace,
            dailyCap: integerOption(
              args.dailyCap ?? process.env.REMBERO_AUTO_CAPTURE_DAILY_CAP,
              DEFAULT_AUTO_CAPTURE_DAILY_CAP,
              'auto-capture daily cap'
            ),
            tailBytes: integerOption(
              args.tailBytes ?? process.env.REMBERO_AUTO_CAPTURE_TAIL_BYTES,
              DEFAULT_TRANSCRIPT_TAIL_BYTES,
              'auto-capture tail bytes'
            ),
          }
        );
        if (args.json) console.log(stringifyBoundedResult(result, 'CLI result'));
        return;
      }
      const validTimeMode = validTimeModeOption(args.validTimeMode);
      const result = await rememberText(
        {
          store,
          llm: clientFromEnv(),
          llmAllowedNamespaces,
          entityIdentity: entityIdentitySetting,
        },
        text,
        args.namespace,
        {
          validTimeMode,
          integrityEnforcement: integritySetting,
          entityIdentity: entityIdentitySetting,
        }
      );
      console.log(stringifyBoundedResult(result, 'CLI result'));
      return;
    }
    case 'recall': {
      const result = await recallQuestion(
        {
          store,
          llm: clientFromEnv(),
          llmAllowedNamespaces,
          recallSchemaPredicateLimit: recallSchemaPredicateLimitOption(
            args.schemaPredicateLimit
          ),
          entityIdentity: entityIdentitySetting,
        },
        text,
        namespaces,
        recordedSequence === undefined ? {} : { recordedSequence }
      );
      assertBoundedOutput(result.answer, 'CLI recall answer');
      console.log(result.answer);
      const recorded = result.recordedSnapshot === undefined
        ? ''
        : `, recorded: ${result.recordedSnapshot.sequence}/${result.recordedSnapshot.journalEntries}`;
      console.log(
        `  (status: ${result.status}, query: ${result.query ?? 'n/a'}, matches: ${result.bindings.length}${recorded})`
      );
      return;
    }
    case 'recall-explain': {
      const proofLimit = proofLimitOption(args.proofLimit);
      const result = await recallQuestion(
        {
          store,
          llm: clientFromEnv(),
          llmAllowedNamespaces,
          recallSchemaPredicateLimit: recallSchemaPredicateLimitOption(
            args.schemaPredicateLimit
          ),
          entityIdentity: entityIdentitySetting,
        },
        text,
        namespaces,
        {
          explain: true,
          ...(proofLimit === undefined ? {} : { proofLimit }),
          ...(graphSelector === undefined ? {} : { graphSelector }),
          ...(recordedSequence === undefined ? {} : { recordedSequence }),
        }
      );
      console.log(stringifyBoundedResult(result, 'CLI result'));
      return;
    }
    case 'query': {
      const result = queryTool(
        { store, entityIdentity: entityIdentitySetting },
        {
          query: text,
          namespaces,
          ...(recordedSequence === undefined ? {} : { recordedSequence }),
        }
      );
      console.log(
        stringifyBoundedResult(
          recordedSequence === undefined ? result.bindings : result,
          'CLI result'
        )
      );
      return;
    }
    case 'assert': {
      const result = assertFactsTool(
        { store, integrityEnforcement },
        { clauses: text, namespace: args.namespace, opId: operationId }
      );
      console.log(stringifyBoundedResult(result, 'CLI result'));
      return;
    }
    case 'explain': {
      const proofLimit = proofLimitOption(args.proofLimit);
      const result = explainQueryTool(
        { store, entityIdentity: entityIdentitySetting },
        {
          query: text,
          namespaces,
          ...(proofLimit === undefined ? {} : { proofLimit }),
          ...(graphSelector === undefined ? {} : { graphSelector }),
          ...(recordedSequence === undefined ? {} : { recordedSequence }),
        }
      );
      console.log(stringifyBoundedResult(result, 'CLI result'));
      return;
    }
    case 'check': {
      const proofLimit = proofLimitOption(args.proofLimit);
      const maxViolations = maxViolationsOption(args.maxViolations);
      const result = checkIntegrityTool(
        { store, entityIdentity: entityIdentitySetting },
        {
          namespaces,
          ...(proofLimit === undefined ? {} : { proofLimit }),
          ...(maxViolations === undefined ? {} : { maxViolations }),
          ...(graphSelector === undefined ? {} : { graphSelector }),
          ...(recordedSequence === undefined ? {} : { recordedSequence }),
        }
      );
      console.log(stringifyBoundedResult(result, 'CLI result'));
      if (result.status === 'violations') process.exitCode = 2;
      return;
    }
    case 'forget': {
      const result = forgetTool(
        { store, integrityEnforcement },
        { pattern: text, namespace: args.namespace, opId: operationId }
      );
      console.log(`removed ${result.removed} clause(s)`);
      return;
    }
    case 'history': {
      const result = historyTool(
        { store },
        {
          pattern: text,
          namespaces,
          limit: integerOption(args.limit, MAX_HISTORY_EVENTS, 'history limit'),
        }
      );
      if (args.json) {
        console.log(stringifyBoundedResult(result, 'CLI result'));
        return;
      }
      if (result.events.length === 0) {
        console.log(`no history for ${result.pattern}`);
        return;
      }
      for (const event of result.events) {
        const current = event.current ? ' [current]' : '';
        const archive = event.archivedAs ? ` -> ${event.archivedAs}` : '';
        console.log(
          `${event.sequence}.${event.position} ${event.ts} ${event.namespace} ${event.action}${current}: ${event.clause}${archive}`
        );
        if (event.sourceText) console.log(`  source: ${event.sourceText}`);
      }
      return;
    }
    case 'export': {
      for (const ns of store.listNamespaces()) {
        console.log(`% namespace: ${ns}`);
        for (const clause of store.load(ns)) console.log(serializeClause(clause));
        console.log('');
      }
      return;
    }
    case 'import': {
      const [ns, file] = args.positional;
      if (!ns || !file) {
        console.error('usage: rembero import <namespace> <file.dl>');
        process.exitCode = 1;
        return;
      }
      const size = statSync(file).size;
      if (size > MAX_INPUT_BYTES) {
        throw new Error(`import file exceeds ${MAX_INPUT_BYTES} bytes`);
      }
      const result = store.assert(
        ns,
        readFileSync(file, 'utf8'),
        {
          ...(operationId === undefined ? {} : { opId: operationId }),
          ...(integrityEnforcement === undefined ? {} : { integrity: integrityEnforcement }),
        }
      );
      console.log(`imported ${result.added.length} clause(s), ${result.duplicates} duplicate(s) skipped`);
      return;
    }
    case 'sqlite-build':
      console.log(buildSqliteExtension());
      return;
    case 'sqlite-sql':
    case 'sqlite-query':
    case 'sqlite-explain': {
      const [databasePath, ...ruleParts] = args.positional;
      const rule = ruleParts.join(' ');
      if (!databasePath || !rule) {
        console.error(`usage: rembero ${command} <database> <datalog-program>`);
        process.exitCode = 1;
        return;
      }
      const database = await openDatalogDatabase(databasePath, {
        extensionPath: args.extensionPath,
      });
      try {
        const result = command === 'sqlite-sql'
          ? database.datalogSql(rule)
          : stringifyBoundedResult(
              command === 'sqlite-explain'
                ? database.datalogExplain(rule)
                : database.datalogQuery(rule),
              'CLI result'
            );
        console.log(result);
      } finally {
        database.close();
      }
      return;
    }
    case 'list': {
      const result = listMemoriesTool(
        { store },
        {
          namespaces,
          ...(recordedSequence === undefined ? {} : { recordedSequence }),
        }
      );
      console.log(stringifyBoundedResult(result, 'CLI result'));
      return;
    }
    case 'review': {
      const days = integerOption(args.days, 7, 'review days');
      const review = store.reviewAutoCaptures({ days, namespace: args.namespace });
      const selectedNumbers = reviewSelections(args.forget, review.facts.length);
      if (selectedNumbers.length > 0) {
        const selectedFacts = selectedNumbers.map((number) => review.facts[number - 1]);
        const result = store.pruneAutoCaptureFacts(selectedFacts, {
          ...(integrityEnforcement === undefined
            ? {}
            : { integrity: integrityEnforcement }),
        });
        if (args.json) {
          console.log(
            stringifyBoundedResult(
              { ...result, selected: selectedNumbers, facts: selectedFacts },
              'CLI result'
            )
          );
        } else {
          console.log(`removed ${result.removed} auto-captured fact(s)`);
        }
        return;
      }
      if (args.json) {
        console.log(stringifyBoundedResult(review, 'CLI result'));
        return;
      }
      for (const capture of review.captures) {
        const detail = capture.reason ? ` (${capture.reason})` : '';
        console.log(
          `${capture.ts}  ${capture.namespace}  ${capture.status}${detail}  ${capture.captureId}`
        );
      }
      if (review.facts.length === 0) {
        console.log(`no auto-captured facts in the last ${days} day(s)`);
        return;
      }
      console.log('');
      review.facts.forEach((fact, index) => {
        console.log(
          `${index + 1}. ${fact.current ? '[current]' : '[removed]'} ${fact.namespace}: ${fact.clause}`
        );
      });
      console.log('\nPrune with: rembero review --forget <number,...>');
      return;
    }
    case 'init-hooks':
    case 'remove-hooks': {
      const settingsPath = resolve(args.settingsPath ?? defaultClaudeSettingsPath());
      const remove = command === 'remove-hooks' || args.remove;
      const result = remove
        ? removeClaudeHook({ settingsPath })
        : installClaudeHook({
            settingsPath,
            nodePath: process.execPath,
            cliPath: resolve(process.argv[1]),
            namespace: args.namespace ?? 'default',
            dailyCap: integerOption(
              args.dailyCap ?? process.env.REMBERO_AUTO_CAPTURE_DAILY_CAP,
              DEFAULT_AUTO_CAPTURE_DAILY_CAP,
              'auto-capture daily cap'
            ),
            tailBytes: integerOption(
              args.tailBytes ?? process.env.REMBERO_AUTO_CAPTURE_TAIL_BYTES,
              DEFAULT_TRANSCRIPT_TAIL_BYTES,
              'auto-capture tail bytes'
            ),
          });
      console.log(
        `${remove ? 'removed' : 'installed'} Rembero Claude hook${result.changed ? '' : ' (already current)'}: ${result.settingsPath}`
      );
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((e: unknown) => {
  if (e instanceof IncompleteHistoryError) {
    console.error(stringifyBoundedResult(e.toJSON(), 'CLI recorded history error'));
    process.exitCode = 5;
    return;
  }
  if (e instanceof OperationConflictError) {
    console.error(stringifyBoundedResult(e.toJSON(), 'CLI operation conflict'));
    process.exitCode = 4;
    return;
  }
  if (e instanceof IntegrityViolationError) {
    try {
      console.error(stringifyBoundedResult(e.toJSON(), 'CLI integrity rejection'));
    } catch {
      console.error(
        JSON.stringify({
          error: 'integrity_rejection_output_exceeded',
          message: 'write was rejected, but complete evidence exceeds the CLI output bound',
          mode: e.mode,
          baselineViolationCount: e.baselineViolationCount,
          blockingViolationCount: e.blockingViolations.length,
          introducedViolationCount: e.introducedViolations.length,
        })
      );
    }
    process.exitCode = 3;
    return;
  }
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
