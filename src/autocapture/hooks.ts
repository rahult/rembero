import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultClaudeConfigDir, MAX_TRANSCRIPT_TAIL_BYTES } from './transcript.js';

export const MANAGED_HOOK_MARKER = 'rembero-auto-capture-v1';
export const DEFAULT_AUTO_CAPTURE_DAILY_CAP = 10;
export const MAX_AUTO_CAPTURE_DAILY_CAP = 100;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const NAMESPACE_RE = /^[a-z0-9_-]+$/;

export interface InstallClaudeHookOptions {
  settingsPath: string;
  nodePath: string;
  cliPath: string;
  namespace: string;
  dailyCap: number;
  tailBytes: number;
}

export interface RemoveClaudeHookOptions {
  settingsPath: string;
}

export interface HookChangeResult {
  changed: boolean;
  settingsPath: string;
}

interface JsonObject {
  [key: string]: unknown;
}

export function defaultClaudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultClaudeConfigDir(env), 'settings.json');
}

export function validateAutoCaptureDailyCap(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_AUTO_CAPTURE_DAILY_CAP) {
    throw new Error(
      `auto-capture daily cap must be an integer between 1 and ${MAX_AUTO_CAPTURE_DAILY_CAP}`
    );
  }
  return value;
}

export function validateAutoCaptureTailBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > MAX_TRANSCRIPT_TAIL_BYTES) {
    throw new Error(
      `auto-capture tail byte limit must be an integer between 1024 and ${MAX_TRANSCRIPT_TAIL_BYTES}`
    );
  }
  return value;
}

function validateNamespace(namespace: string): string {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(
      `invalid namespace '${namespace}': use lowercase letters, digits, '_' or '-'`
    );
  }
  return namespace;
}

function readSettings(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const linkStat = lstatSync(path);
  if (linkStat.isSymbolicLink()) {
    throw new Error('refusing to replace a symbolic-link Claude settings file');
  }
  if (!linkStat.isFile()) throw new Error('Claude settings path must name a regular file');
  if (linkStat.size > MAX_SETTINGS_BYTES) {
    throw new Error(`Claude settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Claude settings file is not valid JSON: ${path}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Claude settings must contain a JSON object');
  }
  return parsed as JsonObject;
}

function writeSettings(path: string, settings: JsonObject): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporary = join(parent, `.settings.json.rembero-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up when creation or rename never completed.
    }
    throw error;
  }
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function isManagedHandler(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const handler = value as JsonObject;
  return (
    handler.type === 'command' &&
    Array.isArray(handler.args) &&
    handler.args.includes(MANAGED_HOOK_MARKER)
  );
}

function withoutManagedStopHook(settings: JsonObject): JsonObject {
  const next = structuredClone(settings);
  if (next.hooks === undefined) return next;
  const hooks = asObject(next.hooks, "Claude settings 'hooks'");
  if (hooks.Stop === undefined) return next;
  if (!Array.isArray(hooks.Stop)) {
    throw new Error("Claude settings 'hooks.Stop' must be an array");
  }

  const groups: unknown[] = [];
  for (const rawGroup of hooks.Stop) {
    const group = asObject(rawGroup, "Claude settings 'hooks.Stop' entry");
    if (!Array.isArray(group.hooks)) {
      throw new Error("Claude settings Stop matcher group's 'hooks' must be an array");
    }
    const handlers = group.hooks.filter((handler) => !isManagedHandler(handler));
    if (handlers.length > 0) groups.push({ ...group, hooks: handlers });
  }
  if (groups.length > 0) hooks.Stop = groups;
  else delete hooks.Stop;
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

export function installClaudeHook(options: InstallClaudeHookOptions): HookChangeResult {
  const settingsPath = resolve(options.settingsPath);
  const namespace = validateNamespace(options.namespace);
  const dailyCap = validateAutoCaptureDailyCap(options.dailyCap);
  const tailBytes = validateAutoCaptureTailBytes(options.tailBytes);
  if (options.nodePath.trim() === '' || options.cliPath.trim() === '') {
    throw new Error('hook node and CLI paths must be non-empty');
  }

  const current = readSettings(settingsPath);
  const next = withoutManagedStopHook(current);
  const hooks = next.hooks === undefined
    ? ((next.hooks = {}) as JsonObject)
    : asObject(next.hooks, "Claude settings 'hooks'");
  const stop = hooks.Stop === undefined ? [] : hooks.Stop;
  if (!Array.isArray(stop)) throw new Error("Claude settings 'hooks.Stop' must be an array");
  stop.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: resolve(options.nodePath),
        args: [
          resolve(options.cliPath),
          'remember',
          '--batch',
          '--managed-by',
          MANAGED_HOOK_MARKER,
          '--namespace',
          namespace,
          '--daily-cap',
          String(dailyCap),
          '--tail-bytes',
          String(tailBytes),
        ],
        async: true,
        timeout: 120,
      },
    ],
  });
  hooks.Stop = stop;

  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) writeSettings(settingsPath, next);
  return { changed, settingsPath };
}

export function removeClaudeHook(options: RemoveClaudeHookOptions): HookChangeResult {
  const settingsPath = resolve(options.settingsPath);
  if (!existsSync(settingsPath)) return { changed: false, settingsPath };
  const current = readSettings(settingsPath);
  const next = withoutManagedStopHook(current);
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) writeSettings(settingsPath, next);
  return { changed, settingsPath };
}
