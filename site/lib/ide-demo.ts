import type { SqliteScalar } from "./sqlite-wasm";

export interface DemoPreset {
  id: "follow_up" | "collaborators" | "recursive_paths";
  title: string;
  description: string;
  program: string;
  setupSql?: string;
}

export interface LineageEvent {
  id: string;
  kind: "INSERT" | "SQL" | "DATALOG" | "RESET";
  target: string;
  detail: string;
  timestamp: string;
}

export const SAMPLE_SETUP_SQL = `
  DROP TABLE IF EXISTS project_owner;
  DROP TABLE IF EXISTS project_contributor;
  DROP TABLE IF EXISTS promised_update;
  DROP TABLE IF EXISTS status;
  DROP TABLE IF EXISTS edge;

  CREATE TABLE project_owner(project TEXT NOT NULL, person TEXT NOT NULL);
  CREATE TABLE project_contributor(project TEXT NOT NULL, person TEXT NOT NULL);
  CREATE TABLE promised_update(owner TEXT NOT NULL, person TEXT NOT NULL, project TEXT NOT NULL);
  CREATE TABLE status(project TEXT NOT NULL, state TEXT NOT NULL);

  INSERT INTO project_owner VALUES
    ('atlas', 'rahul'),
    ('orchard', 'ava');
  INSERT INTO project_contributor VALUES
    ('atlas', 'maya'),
    ('atlas', 'liam'),
    ('orchard', 'nora');
  INSERT INTO promised_update VALUES
    ('rahul', 'maya', 'atlas'),
    ('rahul', 'liam', 'atlas');
  INSERT INTO status VALUES
    ('atlas', 'blocked'),
    ('orchard', 'active');
`;

export const PRESETS: readonly DemoPreset[] = [
  {
    id: "follow_up",
    title: "Who needs a follow-up?",
    description:
      "Find people who were promised an update for a project that is currently blocked.",
    program: `needs_follow_up(Person, Project) :-
  promised_update(rahul, Person, Project),
  status(Project, blocked).`,
  },
  {
    id: "collaborators",
    title: "Who collaborates on each project?",
    description:
      "Join ownership and contribution tables while excluding the owner from the result.",
    program: `collaborator(Person, Project) :-
  project_owner(Project, Owner),
  project_contributor(Project, Person),
  Owner != Person.`,
  },
  {
    id: "recursive_paths",
    title: "Which nodes are reachable?",
    description:
      "Use two rules to compute a transitive path until SQLite reaches a deterministic fixpoint.",
    setupSql: `
      CREATE TABLE IF NOT EXISTS edge(source TEXT NOT NULL, target TEXT NOT NULL);
      DELETE FROM edge;
      INSERT INTO edge VALUES
        ('atlas', 'memory'),
        ('memory', 'proof'),
        ('proof', 'source');
    `,
    program: `path(X, Y) :- edge(X, Y).
path(X, Y) :- edge(X, Z), path(Z, Y).`,
  },
] as const;

export const DEFAULT_SQL = "SELECT project, state FROM status ORDER BY project;";

export const INITIAL_LINEAGE: readonly LineageEvent[] = [
  {
    id: "seed-owner",
    kind: "INSERT",
    target: "project_owner",
    detail: "2 sample rows",
    timestamp: "sample seed",
  },
  {
    id: "seed-contributors",
    kind: "INSERT",
    target: "project_contributor",
    detail: "3 sample rows",
    timestamp: "sample seed",
  },
  {
    id: "seed-promises",
    kind: "INSERT",
    target: "promised_update",
    detail: "2 sample rows",
    timestamp: "sample seed",
  },
  {
    id: "seed-status",
    kind: "INSERT",
    target: "status",
    detail: "2 sample rows",
    timestamp: "sample seed",
  },
] as const;

export const INSERT_DEFAULTS: Record<string, Record<string, SqliteScalar>> = {
  project_owner: { project: "kiln", person: "maya" },
  project_contributor: { project: "kiln", person: "nora" },
  promised_update: { owner: "rahul", person: "nora", project: "kiln" },
  status: { project: "kiln", state: "blocked" },
  edge: { source: "source", target: "answer" },
};

export const CONSTRAINT_EXAMPLE =
  ":- status(Project, active), status(Project, blocked).";

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function formatCell(value: SqliteScalar): string {
  if (value === null) return "NULL";
  return String(value);
}

export function eventTime(): string {
  return new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}
