import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  MemoryStackAdapterDescriptor,
  MemoryStackAdapterDisclosures,
  MemoryStackCapabilities,
} from './memory-stack-contract.js';
import type { ExternalCommandAdapterOptions } from './memory-stack-adapters.js';

export const MEMORY_STACK_ADAPTER_MANIFEST_VERSION =
  'rembero.memory-stack-adapter.v1' as const;

export interface LoadedExternalAdapterManifest {
  descriptor: MemoryStackAdapterDescriptor;
  command: ExternalCommandAdapterOptions;
  manifestPath: string;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

function stringArray(value: unknown, label: string, maxItems = 32): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string' || item.length > 1_000)
  ) {
    throw new Error(`${label} must be an array of at most ${maxItems} strings`);
  }
  return [...value];
}

function integerValue(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function capabilitiesValue(value: unknown): MemoryStackCapabilities {
  const source = objectValue(value, 'adapter.capabilities');
  const keys = [
    'answerRows',
    'rankedRetrieval',
    'citations',
    'rules',
    'temporalUpdates',
    'trustViews',
  ] as const;
  const capabilities = {} as MemoryStackCapabilities;
  for (const key of keys) {
    if (typeof source[key] !== 'boolean') {
      throw new Error(`adapter.capabilities.${key} must be boolean`);
    }
    capabilities[key] = source[key];
  }
  return capabilities;
}

function disclosuresValue(value: unknown): MemoryStackAdapterDisclosures {
  const source = objectValue(value, 'adapter.disclosures');
  const packageSource = objectValue(source.packages, 'adapter.disclosures.packages');
  const packages: Record<string, string> = {};
  const entries = Object.entries(packageSource);
  if (entries.length === 0 || entries.length > 32) {
    throw new Error('adapter.disclosures.packages must contain between 1 and 32 pins');
  }
  for (const [name, version] of entries) {
    packages[stringValue(name, 'package name', 100)] = stringValue(
      version,
      `package version for ${name}`,
      100
    );
  }
  const notes = source.notes === undefined
    ? undefined
    : stringArray(source.notes, 'adapter.disclosures.notes');
  return {
    packages,
    embeddingModel: stringValue(
      source.embeddingModel,
      'adapter.disclosures.embeddingModel'
    ),
    storage: stringValue(source.storage, 'adapter.disclosures.storage'),
    writePolicy: stringValue(source.writePolicy, 'adapter.disclosures.writePolicy'),
    retrievalPolicy: stringValue(
      source.retrievalPolicy,
      'adapter.disclosures.retrievalPolicy'
    ),
    providerCostBoundary: stringValue(
      source.providerCostBoundary,
      'adapter.disclosures.providerCostBoundary'
    ),
    ...(notes === undefined ? {} : { notes }),
  };
}

export async function loadExternalAdapterManifest(
  inputPath: string
): Promise<LoadedExternalAdapterManifest> {
  const manifestPath = resolve(inputPath);
  const root = objectValue(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
    'adapter manifest'
  );
  if (root.schemaVersion !== MEMORY_STACK_ADAPTER_MANIFEST_VERSION) {
    throw new Error(`unsupported adapter manifest version: ${String(root.schemaVersion)}`);
  }
  const adapter = objectValue(root.adapter, 'adapter');
  const command = objectValue(root.command, 'command');
  const manifestDirectory = dirname(manifestPath);
  const workingDirectory = resolve(
    manifestDirectory,
    command.workingDirectory === undefined
      ? '.'
      : stringValue(command.workingDirectory, 'command.workingDirectory')
  );
  const args = command.args === undefined
    ? []
    : stringArray(command.args, 'command.args', 64);
  return {
    descriptor: {
      id: stringValue(adapter.id, 'adapter.id', 100),
      version: stringValue(adapter.version, 'adapter.version', 200),
      capabilities: capabilitiesValue(adapter.capabilities),
      disclosures: disclosuresValue(adapter.disclosures),
    },
    command: {
      executable: stringValue(command.executable, 'command.executable'),
      args,
      workingDirectory,
      timeoutMs: command.timeoutMs === undefined
        ? 120_000
        : integerValue(command.timeoutMs, 'command.timeoutMs', 1_000, 300_000),
      maxOutputBytes: command.maxOutputBytes === undefined
        ? 1_000_000
        : integerValue(
          command.maxOutputBytes,
          'command.maxOutputBytes',
          1_024,
          10_000_000
        ),
    },
    manifestPath,
  };
}
