import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const installedCli = join(directory, 'node_modules', 'rembero', 'dist', 'cli.js');
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
    'parent(a, b). parent(b, c). ancestor(X, Y) :- parent(X, Y). ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).\n'
  );
  const memoryEnv = { ...process.env, REMBERO_HOME: memoryHome };
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
  console.log(
    'packed install, native recursion, personal proofs, and explanation graph passed'
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
