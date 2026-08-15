#!/usr/bin/env node
import { loadEnv } from './env.js';
import { clientFromEnv, lazyClientFromEnv } from './llm/client.js';
import { rememberText, recallQuestion } from './llm/pipeline.js';
import { serveStdio } from './mcp/server.js';
import { forgetTool, listMemoriesTool, queryTool } from './mcp/tools.js';
import { MemoryStore } from './store/store.js';

const USAGE = `rembero — logic-based memory for chats and agents

Usage:
  rembero serve                          Start the MCP server on stdio
  rembero remember <text>                Extract facts from text and store them
  rembero recall <question>              Answer a question from memory
  rembero query <datalog>                Run a raw Datalog query
  rembero forget <pattern>               Retract facts matching a pattern
  rembero list                           List stored memories

Options:
  -n, --namespace <ns>     Namespace to write to / read from (default: "default")
      --namespaces <a,b|*> Namespaces to search for recall/query/list
`;

interface ParsedArgs {
  positional: string[];
  namespace?: string;
  namespaces?: string[] | '*';
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
  const text = args.positional.join(' ');
  const namespaces = args.namespaces ?? (args.namespace ? [args.namespace] : undefined);

  switch (command) {
    case 'serve':
      await serveStdio({ store, llm: lazyClientFromEnv() });
      return; // keep process alive; transport owns stdio
    case 'remember': {
      const result = await rememberText({ store, llm: clientFromEnv() }, text, args.namespace);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'recall': {
      const result = await recallQuestion({ store, llm: clientFromEnv() }, text, namespaces);
      console.log(result.answer);
      console.log(`  (query: ${result.query ?? 'n/a'}, matches: ${result.bindings.length})`);
      return;
    }
    case 'query': {
      const result = queryTool({ store }, { query: text, namespaces });
      console.log(JSON.stringify(result.bindings, null, 2));
      return;
    }
    case 'forget': {
      const result = forgetTool({ store }, { pattern: text, namespace: args.namespace });
      console.log(`removed ${result.removed} clause(s)`);
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
