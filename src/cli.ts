#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { serializeClause } from './engine/index.js';
import { loadEnv } from './env.js';
import { clientFromEnv, lazyClientFromEnv } from './llm/client.js';
import { rememberText, recallQuestion } from './llm/pipeline.js';
import { serveStdio } from './mcp/server.js';
import { explainQueryTool, forgetTool, listMemoriesTool, queryTool } from './mcp/tools.js';
import { MemoryStore } from './store/store.js';
import { MAX_INPUT_BYTES, llmNamespaceAllowlistFromEnv } from './safety.js';
import { buildSqliteExtension, openDatalogDatabase } from './sqlite/extension.js';

const USAGE = `rembero — logic-based memory for chats and agents

Usage:
  rembero serve                          Start the MCP server on stdio
  rembero remember <text>                Extract facts from text and store them
  rembero recall <question>              Answer a question from memory
  rembero recall-explain <question>      Recall with proofs, sources, and a graph
  rembero query <datalog>                Run a raw Datalog query
  rembero explain <datalog>              Query with proofs, sources, and a knowledge graph
  rembero forget <pattern>               Retract facts matching a pattern
  rembero list                           List stored memories
  rembero export                         Print all memories as portable Datalog
  rembero import <ns> <file>             Load clauses from a .dl file into a namespace
  rembero sqlite-build                   Compile the loadable SQLite extension
  rembero sqlite-sql <db> <rule>         Compile a Datalog rule against a SQLite database
  rembero sqlite-query <db> <program>    Execute a Datalog program against a SQLite database
  rembero sqlite-explain <db> <program>  Execute with one derivation proof per result

Options:
  -n, --namespace <ns>     Namespace to write to / read from (default: "default")
      --namespaces <a,b|*> Namespaces to search for recall/query/list
      --extension <path>   Path to the compiled Rembero SQLite extension
`;

interface ParsedArgs {
  positional: string[];
  namespace?: string;
  namespaces?: string[] | '*';
  extensionPath?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-n' || arg === '--namespace') {
      parsed.namespace = argv[++i];
    } else if (arg === '--namespaces') {
      const value = argv[++i];
      parsed.namespaces = value === '*' ? '*' : value.split(',');
    } else if (arg === '--extension') {
      parsed.extensionPath = argv[++i];
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const store = new MemoryStore();
  const llmAllowedNamespaces = llmNamespaceAllowlistFromEnv();
  const text = args.positional.join(' ');
  const namespaces = args.namespaces ?? (args.namespace ? [args.namespace] : undefined);

  switch (command) {
    case 'serve':
      await serveStdio({ store, llm: lazyClientFromEnv(), llmAllowedNamespaces });
      return; // keep process alive; transport owns stdio
    case 'remember': {
      const result = await rememberText(
        { store, llm: clientFromEnv(), llmAllowedNamespaces },
        text,
        args.namespace
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'recall': {
      const result = await recallQuestion(
        { store, llm: clientFromEnv(), llmAllowedNamespaces },
        text,
        namespaces
      );
      console.log(result.answer);
      console.log(`  (query: ${result.query ?? 'n/a'}, matches: ${result.bindings.length})`);
      return;
    }
    case 'recall-explain': {
      const result = await recallQuestion(
        { store, llm: clientFromEnv(), llmAllowedNamespaces },
        text,
        namespaces,
        { explain: true }
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'query': {
      const result = queryTool({ store }, { query: text, namespaces });
      console.log(JSON.stringify(result.bindings, null, 2));
      return;
    }
    case 'explain': {
      const result = explainQueryTool({ store }, { query: text, namespaces });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'forget': {
      const result = forgetTool({ store }, { pattern: text, namespace: args.namespace });
      console.log(`removed ${result.removed} clause(s)`);
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
      const result = store.assert(ns, readFileSync(file, 'utf8'));
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
          : JSON.stringify(
              command === 'sqlite-explain'
                ? database.datalogExplain(rule)
                : database.datalogQuery(rule),
              null,
              2
            );
        console.log(result);
      } finally {
        database.close();
      }
      return;
    }
    case 'list': {
      const result = listMemoriesTool({ store }, { namespaces });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
