import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

export interface OpenDatalogDatabaseOptions {
  extensionPath?: string;
}

export type DatalogRow = Record<string, unknown>;

export interface DatalogProof {
  predicate: string;
  values: unknown[];
  rule?: number;
  because?: DatalogProof[];
}

export interface DatalogExplanation {
  row: DatalogRow;
  proof: DatalogProof;
}

function containsArithmeticSyntax(program: string): boolean {
  const previousSignificant = (index: number): string => {
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      if (!/\s/.test(program[cursor])) return program[cursor];
    }
    return '';
  };
  const nextSignificant = (index: number): string => {
    for (let cursor = index + 1; cursor < program.length; cursor++) {
      if (!/\s/.test(program[cursor])) return program[cursor];
    }
    return '';
  };

  for (let index = 0; index < program.length; index++) {
    const char = program[index];
    if (char === '+' || char === '*' || char === '/') return true;
    if (char !== '-') continue;
    const previous = previousSignificant(index);
    if (previous === ':' || previous === '?') continue;
    const next = nextSignificant(index);
    const previousEndsOperand = /[a-zA-Z0-9_)]/.test(previous);
    const isNegativeNumericLiteral = !previousEndsOperand && /[0-9]/.test(next);
    if (!isNegativeNumericLiteral) return true;
  }
  return false;
}

function assertPortableEngineOnlySyntax(program: string): void {
  let quoted = false;
  let visible = '';
  for (let index = 0; index < program.length; index++) {
    const char = program[index];
    if (quoted) {
      visible += ' ';
      if (char === "'" && program[index + 1] === "'") {
        visible += ' ';
        index++;
      }
      else if (char === "'") quoted = false;
      continue;
    }
    if (char === "'") {
      quoted = true;
      visible += ' ';
      continue;
    }
    if (char === '%') {
      while (index < program.length && program[index] !== '\n') {
        visible += ' ';
        index++;
      }
      visible += '\n';
      continue;
    }
    if (char === '\\' && program[index + 1] === '+') {
      throw new Error(
        'stratified negation is currently supported by the portable Datalog engine, not the SQLite extension'
      );
    }
    visible += char;
  }
  if (
    /\b(?:count|sum|min|max)\s*\([^)]*\)\s+as\s+[A-Z][a-zA-Z0-9_]*\s+where\b/.test(
      visible
    )
  ) {
    throw new Error(
      'scalar aggregation is currently supported by the portable Datalog engine, not the SQLite extension'
    );
  }
  if (containsArithmeticSyntax(visible)) {
    throw new Error(
      'arithmetic comparison expressions are currently supported by the portable Datalog engine, not the SQLite extension'
    );
  }
}

function platformLibraryName(): string {
  switch (process.platform) {
    case 'darwin':
      return 'rembero.dylib';
    case 'linux':
      return 'rembero.so';
    default:
      throw new Error(`Rembero SQLite V0 does not support ${process.platform}.`);
  }
}

function packageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export function buildSqliteExtension(): string {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`Rembero SQLite V0 does not support ${process.platform}.`);
  }
  const root = packageRoot();
  const output = execFileSync('sh', [resolve(root, 'native', 'build.sh')], {
    cwd: root,
    encoding: 'utf8',
  });
  const builtPath = output.trim().split('\n').at(-1) ?? '';
  if (!existsSync(builtPath)) {
    throw new Error('SQLite extension build completed without producing a library.');
  }
  return builtPath;
}

export function resolveSqliteExtensionPath(explicitPath?: string): string {
  const configured = explicitPath ?? process.env.REMBERO_SQLITE_EXTENSION;
  const candidate = resolve(configured ?? resolve(packageRoot(), 'build', platformLibraryName()));
  if (!existsSync(candidate)) {
    throw new Error(
      `Rembero SQLite extension not found at ${candidate}. ` +
        'Run "rembero sqlite-build" (or "npm run build:sqlite" in a checkout), ' +
        'or set REMBERO_SQLITE_EXTENSION.'
    );
  }
  return candidate;
}

export class DatalogDatabase {
  constructor(private readonly database: DatabaseSync) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  datalogSql(rule: string): string {
    assertPortableEngineOnlySyntax(rule);
    const row = this.database.prepare('SELECT datalog_sql(?) AS sql').get(rule) as
      | { sql: unknown }
      | undefined;
    if (typeof row?.sql !== 'string') {
      throw new Error('SQLite datalog_sql returned an invalid result');
    }
    return row.sql;
  }

  datalogQuery(rule: string): DatalogRow[] {
    assertPortableEngineOnlySyntax(rule);
    const row = this.database.prepare('SELECT datalog_query(?) AS result').get(rule) as
      | { result: unknown }
      | undefined;
    if (typeof row?.result !== 'string') {
      throw new Error('SQLite datalog_query returned an invalid result');
    }
    const result: unknown = JSON.parse(row.result);
    if (!Array.isArray(result)) {
      throw new Error('SQLite datalog_query returned invalid JSON');
    }
    return result as DatalogRow[];
  }

  datalogExplain(program: string): DatalogExplanation[] {
    assertPortableEngineOnlySyntax(program);
    const row = this.database.prepare('SELECT datalog_explain(?) AS result').get(program) as
      | { result: unknown }
      | undefined;
    if (typeof row?.result !== 'string') {
      throw new Error('SQLite datalog_explain returned an invalid result');
    }
    const result: unknown = JSON.parse(row.result);
    if (!Array.isArray(result)) {
      throw new Error('SQLite datalog_explain returned invalid JSON');
    }
    return result as DatalogExplanation[];
  }

  close(): void {
    this.database.close();
  }
}

export async function openDatalogDatabase(
  path: string,
  options: OpenDatalogDatabaseOptions = {}
): Promise<DatalogDatabase> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    throw new Error('SQLite integration requires Node.js 22.13 or newer.', { cause: error });
  }

  const database = new sqlite.DatabaseSync(path, { allowExtension: true });
  try {
    database.loadExtension(
      resolveSqliteExtensionPath(options.extensionPath),
      'sqlite3_rembero_init'
    );
    database.enableLoadExtension(false);
    return new DatalogDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
