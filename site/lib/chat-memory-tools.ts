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
  originalName: string;
  normalizedName: boolean;
}

export interface ChatToolExecution {
  command: string;
  result: {
    rows: SqliteRow[] | Array<Record<string, string | number>>;
    explanations?: BrowserDatalogExplanation[];
  };
  durationMs: number;
}

export interface ChatMemorySeedVerification {
  tableCount: number;
  rowCount: number;
}

export const CHAT_MEMORY_SQLITE_SETUP = `
  DROP TABLE IF EXISTS status;
  DROP TABLE IF EXISTS blocker;
  DROP TABLE IF EXISTS prefers_meeting;
  DROP TABLE IF EXISTS promised_update;
  DROP TABLE IF EXISTS pending_meeting;
  DROP TABLE IF EXISTS review_slot;

  CREATE TABLE status(project TEXT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE blocker(project TEXT NOT NULL, blocker TEXT NOT NULL);
  CREATE TABLE prefers_meeting(person TEXT NOT NULL, window TEXT NOT NULL);
  CREATE TABLE promised_update(owner TEXT NOT NULL, person TEXT NOT NULL, project TEXT NOT NULL);
  CREATE TABLE pending_meeting(person TEXT NOT NULL, meeting TEXT NOT NULL);
  CREATE TABLE review_slot(project TEXT NOT NULL, day TEXT NOT NULL, window TEXT NOT NULL);

  INSERT INTO status VALUES ('atlas', 'blocked'), ('orchard', 'active');
  INSERT INTO blocker VALUES ('atlas', 'vendor_security_review');
  INSERT INTO prefers_meeting VALUES ('maya', 'morning'), ('liam', 'afternoon');
  INSERT INTO promised_update VALUES
    ('rahul', 'maya', 'atlas'),
    ('rahul', 'liam', 'atlas');
  INSERT INTO pending_meeting VALUES ('jordan', 'roadmap_sync');
  INSERT INTO review_slot VALUES ('atlas', 'tuesday', 'morning');
`;

export const CHAT_MEMORY_SQLITE_VERIFY = `SELECT
  (SELECT COUNT(*)
     FROM sqlite_schema
    WHERE type = 'table'
      AND name IN (
        'status',
        'blocker',
        'prefers_meeting',
        'promised_update',
        'pending_meeting',
        'review_slot'
      )) AS tableCount,
  (SELECT COUNT(*) FROM status)
    + (SELECT COUNT(*) FROM blocker)
    + (SELECT COUNT(*) FROM prefers_meeting)
    + (SELECT COUNT(*) FROM promised_update)
    + (SELECT COUNT(*) FROM pending_meeting)
    + (SELECT COUNT(*) FROM review_slot) AS rowCount`;

export async function verifyChatMemorySeed(
  database: BrowserDatalogDatabase,
): Promise<ChatMemorySeedVerification> {
  const [row] = await database.exec(CHAT_MEMORY_SQLITE_VERIFY);
  const tableCount = row?.tableCount;
  const rowCount = row?.rowCount;
  if (typeof tableCount !== "number" || typeof rowCount !== "number") {
    throw new Error("SQLite seed verification returned no counts");
  }
  if (tableCount !== 6 || rowCount !== 9) {
    throw new Error(
      `SQLite seed verification expected 6 tables and 9 rows, received ${tableCount} tables and ${rowCount} rows`,
    );
  }
  return { tableCount, rowCount };
}

const SQL_BY_CASE: Record<ChatMemoryScenarioId, string> = {
  "schedule-review": `SELECT s.project, s.state, b.blocker, p.person, r.day, r.window
FROM status AS s
JOIN blocker AS b ON b.project = s.project
JOIN review_slot AS r ON r.project = s.project
JOIN prefers_meeting AS p ON p.person = 'maya' AND p.window = r.window
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
  "schedule-review": `schedule_review_atlas(Day, Window, Blocker) :-
  review_slot(atlas, Day, Window),
  status(atlas, blocked),
  blocker(atlas, Blocker),
  prefers_meeting(maya, Window).`,
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
      name.trim().length === 0 ||
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
      originalName: name,
      normalizedName: name.toLowerCase() !== expected.name.toLowerCase(),
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
    originalName: definition.name,
    normalizedName: false,
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
