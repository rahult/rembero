import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'rembero-package-smoke-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    input: options.input,
    env: options.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`
    );
  }
  return result.stdout.trim();
}

try {
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', directory]);
  const archive = readdirSync(directory).find((entry) => entry.endsWith('.tgz'));
  if (!archive) throw new Error('npm pack did not produce an archive');

  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, archive)],
    { cwd: directory }
  );
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import { IncompleteHistoryError, IntegrityViolationError, MemoryStore, OperationConflictError, canonicalizeKnowledge, checkIntegrity, evaluate, evaluateQuerySpec, explainKnowledge, inspectConflicts, parseProgram, parseQuery, parseQuerySpec, retrieveQuestion, selectExplanationGraph, selectRecallSchema, sqliteDatalogExecutionMode } from 'rembero'; " +
        "const rows = evaluateQuerySpec(parseProgram('item(a). item(b).'), parseQuerySpec('count(*) as Count where item(Item)')); " +
        "if (rows[0]?.Count?.value !== 2) throw new Error('public aggregate API failed'); " +
        "const arithmetic = evaluateQuerySpec(parseProgram('score(a, 20). score(b, 14).'), parseQuerySpec('score(X, S), S > 10 + 5')); " +
        "if (arithmetic.length !== 1 || arithmetic[0]?.X?.value !== 'a') throw new Error('public arithmetic API failed'); " +
        "const indexedProgram = parseProgram([...Array.from({ length: 100 }, (_, i) => `related(person_${i}, topic_${i % 7}).`), 'selected(person_99).', 'relevant(X, Y) :- selected(X), related(X, Y).'].join('\\n')); " +
        "const indexedMetrics = { relationLookups: 0, indexedRelationLookups: 0, indexFactsProcessed: 0, candidateFactsVisited: 0 }; " +
        "const indexedRows = evaluate(indexedProgram, parseQuery('relevant(X, Y)'), { metrics: indexedMetrics }); " +
        "const scannedRows = evaluate(indexedProgram, parseQuery('relevant(X, Y)'), { relationIndex: 'off' }); " +
        "if (JSON.stringify(indexedRows) !== JSON.stringify(scannedRows) || indexedMetrics.indexedRelationLookups < 1 || indexedMetrics.indexFactsProcessed !== 100) throw new Error('public relation index API failed'); " +
        "const noise = Array.from({ length: 100 }, (_, i) => `noise_${i}(value_${i}).`).join('\\n'); " +
        "const schema = selectRecallSchema(parseProgram(`${noise}\\nworks_at(mira, acme).`), 'Who employs Mira?', { predicateLimit: 4 }); " +
        "if (!schema.pruned || !schema.selectedPredicates.includes('works_at/2') || schema.summaryBytes > 24576) throw new Error('public recall schema API failed'); " +
        "const integrity = checkIntegrity(parseProgram('active(mira). suspended(mira). :- active(X), suspended(X).')); " +
        "if (integrity.status !== 'violations' || integrity.violationCount !== 1) throw new Error('public integrity API failed'); " +
        "const conflicts = inspectConflicts(parseProgram('active(mira). suspended(mira). :- active(Person), suspended(Person).'), new Map(), { focus: 'mira' }); " +
        "if (conflicts.clusterCount !== 1 || conflicts.clusters[0]?.focus !== 'mira' || !conflicts.clusters[0]?.graph.nodes.some((node) => node.kind === 'conflict')) throw new Error('public conflict view API failed'); " +
        "const reviewStore = new MemoryStore('./review-memory'); reviewStore.assert('default', 'uses_language(atlas, rust). project_owner(atlas, rahul).'); " +
        "const reviewLlm = { responses: ['?- uses_language(atlas, Value).', '?- project_owner(atlas, Owner).'], async complete() { const value = this.responses.shift(); if (value === undefined) throw new Error('review responses exhausted'); return value; } }; " +
        "const review = await retrieveQuestion({ store: reviewStore, llm: reviewLlm }, 'Who owns Atlas?'); " +
        "if (review.query !== 'project_owner(atlas, Owner)' || review.bindings[0]?.Owner !== 'rahul' || review.queryReviews?.[0]?.outcome !== 'corrected') throw new Error('public recall disambiguation API failed'); " +
        "if (typeof IntegrityViolationError !== 'function') throw new Error('public integrity enforcement API failed'); " +
        "const identity = canonicalizeKnowledge(parseProgram(\"rembero_alias('Mira Patel', mira). rembero_entity_position(works_at, 2, 0). works_at('Mira Patel', acme).\")); " +
        "if (identity.clauses[0]?.head.args[0]?.value !== 'mira') throw new Error('public identity API failed'); " +
        "const fullGraph = explainKnowledge(parseProgram('edge(a, b). edge(b, c).'), 'edge(X, Y)'); " +
        "const selectedGraph = selectExplanationGraph(fullGraph, { kind: 'result', row: 1 }); " +
        "if (selectedGraph.rows.length !== 2 || selectedGraph.graphSelection?.selector?.row !== 1 || selectedGraph.graph.nodes.length >= fullGraph.graph.nodes.length) throw new Error('public graph navigation API failed'); " +
        "if (typeof OperationConflictError !== 'function' || typeof IncompleteHistoryError !== 'function') throw new Error('public history or operation error API failed'); " +
        "if (sqliteDatalogExecutionMode('item(X), X = X') !== 'portable' || sqliteDatalogExecutionMode('copy(X) :- item(X).') !== 'native') throw new Error('public SQLite execution mode API failed');",
    ],
    { cwd: directory }
  );
  const installedCli = join(directory, 'node_modules', 'rembero', 'dist', 'cli.js');
  const claudeSettings = join(directory, 'claude', 'settings.json');
  run(
    process.execPath,
    [
      installedCli,
      'init-hooks',
      '--settings',
      claudeSettings,
      '--namespace',
      'personal',
      '--daily-cap',
      '3',
      '--tail-bytes',
      '8192',
    ],
    { cwd: directory }
  );
  const hookSettings = JSON.parse(readFileSync(claudeSettings, 'utf8'));
  const hookHandler = hookSettings.hooks?.Stop?.flatMap(({ hooks }) => hooks).find(
    ({ args }) => Array.isArray(args) && args.includes('rembero-auto-capture-v1')
  );
  if (
    hookHandler?.async !== true ||
    hookHandler.command !== process.execPath ||
    !hookHandler.args.includes('personal')
  ) {
    throw new Error('packaged auto-capture hook installation failed');
  }
  run(
    process.execPath,
    [installedCli, 'init-hooks', '--remove', '--settings', claudeSettings],
    { cwd: directory }
  );
  const removedSettings = JSON.parse(readFileSync(claudeSettings, 'utf8'));
  if (removedSettings.hooks?.Stop !== undefined) {
    throw new Error('packaged auto-capture hook removal failed');
  }
  const extensionPath = run(process.execPath, [installedCli, 'sqlite-build'], {
    cwd: directory,
  });
  if (!extensionPath) throw new Error('packaged sqlite-build returned no extension path');

  const databasePath = join(directory, 'world.db');
  run(
    'sqlite3',
    [databasePath],
    {
      input:
        "CREATE TABLE works_at(person TEXT, company TEXT);" +
        "INSERT INTO works_at VALUES ('alice','acme'),('bob','acme');" +
        "CREATE TABLE edge(source TEXT, target TEXT);" +
        "INSERT INTO edge VALUES ('a','b'),('b','c');" +
        "CREATE TABLE employee(person TEXT);" +
        "INSERT INTO employee VALUES ('bob'),('alice');" +
        "CREATE TABLE suspended(person TEXT);" +
        "INSERT INTO suspended VALUES ('bob');" +
        "CREATE TABLE score(person TEXT, points INTEGER);" +
        "INSERT INTO score VALUES ('bob',14),('alice',20);" +
        "CREATE TABLE baseline(team TEXT, points INTEGER);" +
        "INSERT INTO baseline VALUES ('team',10);",
    }
  );
  const output = run(
    process.execPath,
    [
      installedCli,
      'sqlite-query',
      databasePath,
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
    ],
    { cwd: directory }
  );
  const rows = JSON.parse(output);
  if (rows.length !== 2 || rows[0].X !== 'alice' || rows[1].X !== 'bob') {
    throw new Error(`unexpected packaged query result: ${output}`);
  }

  const recursiveProgram =
    'path(X, Y) :- edge(X, Y).\n' +
    'path(X, Y) :- edge(X, Z), path(Z, Y).';
  const recursiveOutput = run(
    process.execPath,
    [installedCli, 'sqlite-query', databasePath, recursiveProgram],
    { cwd: directory }
  );
  const recursiveRows = JSON.parse(recursiveOutput);
  if (
    recursiveRows.length !== 3 ||
    !recursiveRows.some((row) => row.X === 'a' && row.Y === 'c')
  ) {
    throw new Error(`unexpected packaged recursive result: ${recursiveOutput}`);
  }
  const explainOutput = run(
    process.execPath,
    [installedCli, 'sqlite-explain', databasePath, recursiveProgram],
    { cwd: directory }
  );
  const explanations = JSON.parse(explainOutput);
  const recursiveProof = explanations.find(
    ({ row }) => row.X === 'a' && row.Y === 'c'
  )?.proof;
  if (recursiveProof?.rule !== 2 || recursiveProof.because?.length !== 2) {
    throw new Error(`unexpected packaged explanation: ${explainOutput}`);
  }

  const advancedProgram =
    'answer(X) :- available(X), score(X, S), baseline(team, B), S > B + 5.\n' +
    'available(X) :- employee(X), \\+ suspended(X).';
  const advancedOutput = run(
    process.execPath,
    [installedCli, 'sqlite-query', databasePath, advancedProgram],
    { cwd: directory }
  );
  const advancedRows = JSON.parse(advancedOutput);
  if (advancedRows.length !== 1 || advancedRows[0].X !== 'alice') {
    throw new Error(`unexpected packaged advanced query result: ${advancedOutput}`);
  }
  const sqliteAggregateOutput = run(
    process.execPath,
    [installedCli, 'sqlite-explain', databasePath, 'count(*) as Count where employee(Person)'],
    { cwd: directory }
  );
  const sqliteAggregate = JSON.parse(sqliteAggregateOutput);
  if (sqliteAggregate[0]?.row?.Count !== 2 || sqliteAggregate[0]?.proof?.aggregated !== true) {
    throw new Error(`unexpected packaged aggregate explanation: ${sqliteAggregateOutput}`);
  }

  const memoryFile = join(directory, 'personal.dl');
  const memoryHome = join(directory, 'personal-home');
  writeFileSync(
    memoryFile,
    'parent(a, b). parent(b, c). ancestor(X, Y) :- parent(X, Y). ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y). ' +
      'employee(alice). employee(bob). suspended(bob). available(X) :- employee(X), \\+ suspended(X). ' +
      'score(alice, 20). score(bob, 14). baseline(team, 10).\n'
  );
  const memoryEnv = { ...process.env, REMBERO_HOME: memoryHome };
  const temporalHome = join(directory, 'temporal-home');
  const temporalEnv = { ...process.env, REMBERO_HOME: temporalHome };
  run(
    process.execPath,
    [
      installedCli,
      'assert',
      'works_at(mira, acme).',
      '--op-id',
      'before',
    ],
    { cwd: directory, env: temporalEnv }
  );
  const supersedeArgs = [
    installedCli,
    'supersede',
    'works_at(mira, initech).',
    '--pattern',
    'works_at(mira, _)',
    '--at',
    '2026-08-16T16:59:00.000Z',
    '--op-id',
    'after',
  ];
  const supersedeOutput = run(process.execPath, supersedeArgs, {
    cwd: directory,
    env: temporalEnv,
  });
  const supersedeReplay = run(process.execPath, supersedeArgs, {
    cwd: directory,
    env: temporalEnv,
  });
  const superseded = JSON.parse(supersedeOutput);
  if (
    supersedeReplay !== supersedeOutput ||
    superseded.retracted !== 1 ||
    superseded.archived[0] !==
      "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z')."
  ) {
    throw new Error(`unexpected packaged supersede result: ${supersedeOutput}`);
  }
  const temporalOutput = run(
    process.execPath,
    [installedCli, 'history', 'works_at(mira, _)', '--json'],
    { cwd: directory, env: temporalEnv }
  );
  const temporalHistory = JSON.parse(temporalOutput);
  if (
    temporalHistory.events.length !== 3 ||
    !temporalHistory.events.some(({ action }) => action === 'superseded') ||
    !temporalHistory.events.some(({ clause, current }) =>
      clause === 'works_at(mira, initech).' && current === true
    )
  ) {
    throw new Error(`unexpected packaged temporal history: ${temporalOutput}`);
  }
  const recordedOutput = run(
    process.execPath,
    [installedCli, 'query', 'works_at(mira, Company)', '--as-of-sequence', '1'],
    { cwd: directory, env: temporalEnv }
  );
  const recorded = JSON.parse(recordedOutput);
  if (
    recorded.bindings[0]?.Company !== 'acme' ||
    recorded.recordedSnapshot?.sequence !== 1 ||
    recorded.recordedSnapshot?.journalEntries !== 2
  ) {
    throw new Error(`unexpected packaged recorded snapshot: ${recordedOutput}`);
  }
  const importOutput = run(
    process.execPath,
    [installedCli, 'import', 'default', memoryFile, '--op-id', 'package-import'],
    { cwd: directory, env: memoryEnv }
  );
  const importReplay = run(
    process.execPath,
    [installedCli, 'import', 'default', memoryFile, '--op-id', 'package-import'],
    { cwd: directory, env: memoryEnv }
  );
  if (importReplay !== importOutput) {
    throw new Error(`unexpected packaged import replay: ${importReplay}`);
  }
  const retryAssert = run(
    process.execPath,
    [installedCli, 'assert', 'package_retry(value).', '--op-id', 'package-retry'],
    { cwd: directory, env: memoryEnv }
  );
  const retryReplay = run(
    process.execPath,
    [installedCli, 'assert', 'package_retry(value).', '--op-id', 'package-retry'],
    { cwd: directory, env: memoryEnv }
  );
  if (retryReplay !== retryAssert || JSON.parse(retryReplay).added[0] !== 'package_retry(value).') {
    throw new Error(`unexpected packaged operation replay: ${retryReplay}`);
  }
  const graphOutput = run(process.execPath, [installedCli, 'explain', 'ancestor(a, Y)'], {
    cwd: directory,
    env: memoryEnv,
  });
  const graph = JSON.parse(graphOutput);
  if (
    graph.rows.length !== 2 ||
    !graph.rows.some(({ bindings }) => bindings.Y === 'c') ||
    !graph.graph.nodes.some(({ kind }) => kind === 'claim')
  ) {
    throw new Error(`unexpected packaged personal graph: ${graphOutput}`);
  }
  const selectedGraphOutput = run(
    process.execPath,
    [installedCli, 'explain', 'ancestor(a, Y)', '--graph-result', '1'],
    { cwd: directory, env: memoryEnv }
  );
  const selectedGraph = JSON.parse(selectedGraphOutput);
  if (
    selectedGraph.rows.length !== 2 ||
    selectedGraph.graphSelection?.selector?.row !== 1 ||
    selectedGraph.graph.nodes.length >= graph.graph.nodes.length
  ) {
    throw new Error(`unexpected packaged graph selection: ${selectedGraphOutput}`);
  }
  const absenceOutput = run(process.execPath, [installedCli, 'explain', 'available(X)'], {
    cwd: directory,
    env: memoryEnv,
  });
  const absenceGraph = JSON.parse(absenceOutput);
  if (
    absenceGraph.rows.length !== 1 ||
    absenceGraph.rows[0].bindings.X !== 'alice' ||
    !absenceGraph.graph.nodes.some(
      ({ kind, predicate }) => kind === 'absence' && predicate === 'suspended'
    )
  ) {
    throw new Error(`unexpected packaged negation graph: ${absenceOutput}`);
  }
  const aggregateOutput = run(
    process.execPath,
    [installedCli, 'query', 'count(*) as Count where employee(Person)'],
    { cwd: directory, env: memoryEnv }
  );
  const aggregateRows = JSON.parse(aggregateOutput);
  if (aggregateRows.length !== 1 || aggregateRows[0].Count !== '2') {
    throw new Error(`unexpected packaged aggregate result: ${aggregateOutput}`);
  }
  const arithmeticOutput = run(
    process.execPath,
    [
      installedCli,
      'query',
      'score(Person, Points), baseline(team, Base), Points > Base + 5',
    ],
    { cwd: directory, env: memoryEnv }
  );
  const arithmeticRows = JSON.parse(arithmeticOutput);
  if (arithmeticRows.length !== 1 || arithmeticRows[0].Person !== 'alice') {
    throw new Error(`unexpected packaged arithmetic result: ${arithmeticOutput}`);
  }
  const aggregateExplainOutput = run(
    process.execPath,
    [installedCli, 'explain', 'max(Person) as Last where employee(Person)'],
    { cwd: directory, env: memoryEnv }
  );
  const aggregateGraph = JSON.parse(aggregateExplainOutput);
  if (
    aggregateGraph.rows[0]?.bindings.Last !== 'bob' ||
    !aggregateGraph.graph.nodes.some(
      ({ kind, op, contributorCount }) =>
        kind === 'aggregate' && op === 'max' && contributorCount === 2
    ) ||
    aggregateGraph.graph.edges.filter(({ kind }) => kind === 'witness').length !== 1
  ) {
    throw new Error(`unexpected packaged aggregate explanation: ${aggregateExplainOutput}`);
  }
  console.log(
    'packed install, non-empty recall disambiguation, focused conflict views, deterministic relation indexing, explicit temporal corrections, recorded-time snapshots, retry-safe writes, graph navigation, explicit entity identity, deterministic recall pruning, safe auto-capture hook lifecycle, temporal history, native recursion, personal proofs, atomic integrity enforcement, stratified negation, scalar aggregation, arithmetic filters, and explanation graph passed'
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
