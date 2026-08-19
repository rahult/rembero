import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export const AGENT_DB_INSTALL_BENCHMARK_VERSION =
  'remembero.agent-db-install.v1' as const;

export interface AgentDbInstallBenchmark {
  schemaVersion: typeof AGENT_DB_INSTALL_BENCHMARK_VERSION;
  generatedAt: string;
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    nodeVersion: string;
    npmVersion: string;
  };
  package: {
    archiveBytes: number;
    installedBytes: number;
  };
  timings: {
    packMs: number;
    coldInstallMs: number;
    cliHelpMs: number;
    firstWriteMs: number;
    firstProofQueryMs: number;
  };
  proof: {
    expectedAnswer: boolean;
    expectedSources: boolean;
    outputBytes: number;
  };
  boundary: {
    npmCache: 'fresh-empty-directory';
    installLifecycleScripts: false;
    llmApiKeysPassedToCli: false;
    queryModelCalls: 0;
    queryEmbeddingCalls: 0;
    queryRemoteCalls: 0;
  };
  gates: {
    passed: boolean;
    failures: string[];
    thresholds: {
      coldInstallMs: number;
      firstWriteMs: number;
      firstProofQueryMs: number;
    };
  };
}

interface CommandResult {
  stdout: string;
  durationMs: number;
}

function commandEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): CommandResult {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 10_000_000,
  });
  const durationMs = performance.now() - started;
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').slice(0, 4_000);
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.signal ?? result.status}: ${stderr}`
    );
  }
  return { stdout: (result.stdout ?? '').trim(), durationMs };
}

function runNpm(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): CommandResult {
  const npmEntrypoint = process.env.npm_execpath;
  return npmEntrypoint === undefined
    ? run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options)
    : run(process.execPath, [npmEntrypoint, ...args], options);
}

async function directoryBytes(path: string): Promise<number> {
  const entry = await lstat(path);
  if (!entry.isDirectory()) return entry.size;
  const children = await readdir(path);
  const sizes = await Promise.all(
    children.map((name) => directoryBytes(join(path, name)))
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export async function runAgentDbInstallBenchmark(options: {
  projectRoot?: string;
  generatedAt?: string;
  coldInstallThresholdMs?: number;
  firstWriteThresholdMs?: number;
  firstProofQueryThresholdMs?: number;
} = {}): Promise<AgentDbInstallBenchmark> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const root = await mkdtemp(join(tmpdir(), 'remembero-clean-install-'));
  const npmCache = join(root, 'npm-cache');
  const npmUserConfig = join(root, 'empty-npmrc');
  const memoryRoot = join(root, 'memory');
  const coldInstallThresholdMs = options.coldInstallThresholdMs ?? 120_000;
  const firstWriteThresholdMs = options.firstWriteThresholdMs ?? 1_000;
  const firstProofQueryThresholdMs = options.firstProofQueryThresholdMs ?? 1_000;
  try {
    await writeFile(npmUserConfig, '');
    const pack = runNpm(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
      { cwd: projectRoot, env: commandEnvironment() }
    );
    const packResult = JSON.parse(pack.stdout) as Array<{
      filename?: unknown;
      size?: unknown;
    }>;
    const filename = packResult[0]?.filename;
    const archiveBytes = packResult[0]?.size;
    if (typeof filename !== 'string' || typeof archiveBytes !== 'number') {
      throw new Error('npm pack returned no archive metadata');
    }
    const archive = join(root, filename);
    const npmEnvironment = commandEnvironment({
      npm_config_cache: npmCache,
      npm_config_userconfig: npmUserConfig,
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_package_lock: 'false',
      npm_config_update_notifier: 'false',
    });
    const install = runNpm(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        archive,
      ],
      { cwd: root, env: npmEnvironment }
    );
    const installedPackage = join(root, 'node_modules', 'remembero');
    const installedBytes = await directoryBytes(installedPackage);
    const cli = process.execPath;
    const cliArgs = [join(installedPackage, 'dist', 'cli.js')];
    const cliEnvironment = commandEnvironment({ REMBERO_HOME: memoryRoot });
    const help = run(cli, [...cliArgs, '--help'], { cwd: root, env: cliEnvironment });
    if (!help.stdout.startsWith('remembero — logic-based memory')) {
      throw new Error('installed Remembero CLI did not return expected help');
    }
    const program = [
      'project_owner(atlas, rahul).',
      'project_contributor(atlas, maya).',
      'collaborator(Person, Project) :-',
      '  project_owner(Project, Owner),',
      '  project_contributor(Project, Person),',
      '  Owner != Person.',
    ].join('\n');
    const write = run(
      cli,
      [...cliArgs, 'assert', program, '--op-id', 'clean-install-seed'],
      { cwd: root, env: cliEnvironment }
    );
    const writePayload = JSON.parse(write.stdout) as { added?: unknown };
    if (!Array.isArray(writePayload.added) || writePayload.added.length !== 3) {
      throw new Error('installed Remembero CLI did not persist the seed program');
    }
    const query = run(
      cli,
      [...cliArgs, 'explain', 'collaborator(Person, atlas)'],
      { cwd: root, env: cliEnvironment }
    );
    const serialized = query.stdout;
    JSON.parse(serialized);
    const expectedAnswer = serialized.includes('maya') && serialized.includes('atlas');
    const expectedSources =
      serialized.includes('project_owner') &&
      serialized.includes('project_contributor');
    const failures: string[] = [];
    if (install.durationMs > coldInstallThresholdMs) {
      failures.push(
        `cold install ${install.durationMs.toFixed(2)}ms exceeded ${coldInstallThresholdMs}ms`
      );
    }
    if (write.durationMs > firstWriteThresholdMs) {
      failures.push(
        `first write ${write.durationMs.toFixed(2)}ms exceeded ${firstWriteThresholdMs}ms`
      );
    }
    if (query.durationMs > firstProofQueryThresholdMs) {
      failures.push(
        `first proof query ${query.durationMs.toFixed(2)}ms exceeded ${firstProofQueryThresholdMs}ms`
      );
    }
    if (!expectedAnswer) failures.push('first proof query omitted the expected answer');
    if (!expectedSources) failures.push('first proof query omitted expected support');
    return {
      schemaVersion: AGENT_DB_INSTALL_BENCHMARK_VERSION,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        npmVersion: runNpm(['--version'], {
          cwd: root,
          env: commandEnvironment(),
        }).stdout,
      },
      package: { archiveBytes, installedBytes },
      timings: {
        packMs: pack.durationMs,
        coldInstallMs: install.durationMs,
        cliHelpMs: help.durationMs,
        firstWriteMs: write.durationMs,
        firstProofQueryMs: query.durationMs,
      },
      proof: {
        expectedAnswer,
        expectedSources,
        outputBytes: Buffer.byteLength(serialized, 'utf8'),
      },
      boundary: {
        npmCache: 'fresh-empty-directory',
        installLifecycleScripts: false,
        llmApiKeysPassedToCli: false,
        queryModelCalls: 0,
        queryEmbeddingCalls: 0,
        queryRemoteCalls: 0,
      },
      gates: {
        passed: failures.length === 0,
        failures,
        thresholds: {
          coldInstallMs: coldInstallThresholdMs,
          firstWriteMs: firstWriteThresholdMs,
          firstProofQueryMs: firstProofQueryThresholdMs,
        },
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
