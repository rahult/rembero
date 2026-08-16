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
      "import { evaluateQuerySpec, parseProgram, parseQuerySpec, selectRecallSchema } from 'rembero'; " +
        "const rows = evaluateQuerySpec(parseProgram('item(a). item(b).'), parseQuerySpec('count(*) as Count where item(Item)')); " +
        "if (rows[0]?.Count?.value !== 2) throw new Error('public aggregate API failed'); " +
        "const arithmetic = evaluateQuerySpec(parseProgram('score(a, 20). score(b, 14).'), parseQuerySpec('score(X, S), S > 10 + 5')); " +
        "if (arithmetic.length !== 1 || arithmetic[0]?.X?.value !== 'a') throw new Error('public arithmetic API failed'); " +
        "const noise = Array.from({ length: 100 }, (_, i) => `noise_${i}(value_${i}).`).join('\\n'); " +
        "const schema = selectRecallSchema(parseProgram(`${noise}\\nworks_at(mira, acme).`), 'Who employs Mira?', { predicateLimit: 4 }); " +
        "if (!schema.pruned || !schema.selectedPredicates.includes('works_at/2') || schema.summaryBytes > 24576) throw new Error('public recall schema API failed');",
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
        "INSERT INTO edge VALUES ('a','b'),('b','c');",
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
      '--input-type=module',
      '--eval',
      "import { join } from 'node:path'; import { MemoryStore } from 'rembero'; " +
        "const store = new MemoryStore(join(process.env.REMBERO_HOME, 'memory')); " +
        "store.assert('default', 'works_at(mira, acme).', { opId: 'before' }); " +
        "const result = store.supersede('default', ['works_at(mira, _)'], 'works_at(mira, initech).', { opId: 'after', at: new Date('2026-08-16T16:59:00.000Z') }); " +
        "if (result.archived.length !== 1 || store.history('works_at(mira, _)').events.length !== 3) throw new Error('public temporal API failed');",
    ],
    { cwd: directory, env: temporalEnv }
  );
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
  run(process.execPath, [installedCli, 'import', 'default', memoryFile], {
    cwd: directory,
    env: memoryEnv,
  });
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
    'packed install, deterministic recall pruning, safe auto-capture hook lifecycle, temporal history, native recursion, personal proofs, stratified negation, scalar aggregation, arithmetic filters, and explanation graph passed'
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
