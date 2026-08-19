import type { ChatMemoryScenarioId } from "./chat-memory-lab";
import type {
  BrowserDatalogDatabase,
  BrowserDatalogExplanation,
  SqliteRow,
} from "./sqlite-wasm";

export type ChatToolLane = "data" | "remembero";

export interface ChatToolDefinition {
  name: "Query";
  description: string;
  parameters: {
    type: "object";
    properties: {
      query: {
        type: "string";
        enum: readonly [string];
      };
    };
    required: readonly ["query"];
    additionalProperties: false;
  };
}

export interface ParsedChatToolCall {
  name: "Query";
  arguments: { query: string };
  lane: ChatToolLane;
  scenarioId: ChatMemoryScenarioId;
}

export interface ChatToolExecution {
  command: string;
  result: {
    rows: SqliteRow[] | Array<Record<string, string | number>>;
    explanations?: BrowserDatalogExplanation[];
  };
  durationMs: number;
}

export const CHAT_MEMORY_SQLITE_SETUP = `
  DROP TABLE IF EXISTS status;
  DROP TABLE IF EXISTS blocker;
  DROP TABLE IF EXISTS prefers_meeting;
  DROP TABLE IF EXISTS promised_update;
  DROP TABLE IF EXISTS pending_meeting;

  CREATE TABLE status(project TEXT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE blocker(project TEXT NOT NULL, blocker TEXT NOT NULL);
  CREATE TABLE prefers_meeting(person TEXT NOT NULL, window TEXT NOT NULL);
  CREATE TABLE promised_update(owner TEXT NOT NULL, person TEXT NOT NULL, project TEXT NOT NULL);
  CREATE TABLE pending_meeting(person TEXT NOT NULL, meeting TEXT NOT NULL);

  INSERT INTO status VALUES ('atlas', 'blocked'), ('orchard', 'active');
  INSERT INTO blocker VALUES ('atlas', 'vendor_security_review');
  INSERT INTO prefers_meeting VALUES ('maya', 'morning'), ('liam', 'afternoon');
  INSERT INTO promised_update VALUES
    ('rahul', 'maya', 'atlas'),
    ('rahul', 'liam', 'atlas');
  INSERT INTO pending_meeting VALUES ('jordan', 'roadmap_sync');
`;

const SQL_BY_CASE: Record<ChatMemoryScenarioId, string> = {
  "schedule-review": `SELECT s.project, s.state, b.blocker, p.person, p.window
FROM status AS s
JOIN blocker AS b ON b.project = s.project
JOIN prefers_meeting AS p ON p.person = 'maya'
WHERE s.project = 'atlas'`,
  "follow-up-maya": `SELECT u.owner, u.person, u.project, s.state
FROM promised_update AS u
JOIN status AS s ON s.project = u.project
WHERE u.person = 'maya'`,
  "unknown-preference": `SELECT m.person, m.meeting, p.window AS stored_preference
FROM pending_meeting AS m
LEFT JOIN prefers_meeting AS p ON p.person = m.person
WHERE m.person = 'jordan'`,
};

const DATALOG_BY_CASE: Record<ChatMemoryScenarioId, string> = {
  "schedule-review": `schedule_review(Project, tuesday, morning, Blocker) :-
  status(Project, blocked),
  blocker(Project, Blocker),
  prefers_meeting(maya, morning).`,
  "follow-up-maya": `needs_follow_up_maya(Project) :-
  promised_update(rahul, maya, Project),
  status(Project, blocked).`,
  "unknown-preference": `missing_preference(Person) :-
  pending_meeting(Person, _),
  \\+ prefers_meeting(Person, _).`,
};

export function chatToolDefinition(
  lane: ChatToolLane,
  question: string,
): ChatToolDefinition {
  return {
    name: "Query",
    description:
      lane === "data"
        ? "Run the prepared read-only SQL query for the active case and return raw SQLite rows."
        : "Evaluate the prepared Remembero relation for the active case and return bindings plus proof from SQLite.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", enum: [question] },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

export function parseChatToolCall(
  raw: string,
  expected: ChatToolDefinition,
  lane: ChatToolLane,
  scenarioId: ChatMemoryScenarioId,
  question: string,
): ParsedChatToolCall | null {
  try {
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      tool?: unknown;
      arguments?: unknown;
      args?: unknown;
    };
    const name = parsed.name ?? parsed.tool;
    let argumentsValue = parsed.arguments ?? parsed.args;
    if (typeof argumentsValue === "string") {
      argumentsValue = JSON.parse(argumentsValue) as unknown;
    }
    if (
      typeof name !== "string" ||
      name.toLowerCase() !== expected.name.toLowerCase() ||
      typeof argumentsValue !== "object" ||
      argumentsValue === null ||
      !("query" in argumentsValue) ||
      (argumentsValue as { query?: unknown }).query !== question
    ) {
      return null;
    }
    return {
      name: expected.name,
      arguments: { query: question },
      lane,
      scenarioId,
    };
  } catch {
    return null;
  }
}

export function simulatedChatToolCall(
  definition: ChatToolDefinition,
  lane: ChatToolLane,
  scenarioId: ChatMemoryScenarioId,
  question: string,
): ParsedChatToolCall {
  return {
    name: definition.name,
    arguments: { query: question },
    lane,
    scenarioId,
  };
}

export async function executeChatTool(
  database: BrowserDatalogDatabase,
  call: ParsedChatToolCall,
): Promise<ChatToolExecution> {
  const started = performance.now();
  if (call.lane === "data") {
    const command = SQL_BY_CASE[call.scenarioId];
    const rows = await database.exec(command);
    return {
      command,
      result: { rows },
      durationMs: performance.now() - started,
    };
  }

  const command = DATALOG_BY_CASE[call.scenarioId];
  const [rows, explanations] = await Promise.all([
    database.datalogQuery(command),
    database.datalogExplain(command),
  ]);
  return {
    command,
    result: { rows, explanations },
    durationMs: performance.now() - started,
  };
}
