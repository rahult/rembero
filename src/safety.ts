export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_NAMESPACE_COUNT = 32;
export const REDACTED_SOURCE = '[sensitive source omitted]';

const SENSITIVE_TEXT_PATTERNS = [
  /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|refresh[_ -]?token|account[_ -]?number|credit[_ -]?card)\b["']?\s*(?:is|=|:)\s*["']?\S+/i,
  /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|refresh[_ -]?token|account[_ -]?number|credit[_ -]?card)\s*\(/i,
  /\b(?:my|your|the)\s+(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|refresh[_ -]?token)\s+(?=\S*[0-9._~+/=-])\S{6,}/i,
  /\b(?:bearer\s+)[a-z0-9._~+/=-]{8,}/i,
  /\b(?:sk|gh[pousr])[-_][a-z0-9_-]{8,}/i,
  /\b(?:\d[ -]*?){13,19}\b/,
];

export function assertBoundedInput(value: string, label: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_INPUT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_INPUT_BYTES} bytes`);
  }
}

export function normalizeUnicodeScalarText(value: string): string {
  return value.replace(/[\uD800-\uDFFF]/g, (unit, offset) => {
    const code = unit.charCodeAt(0);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(offset + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) return unit;
    } else {
      const previous = value.charCodeAt(offset - 1);
      if (previous >= 0xD800 && previous <= 0xDBFF) return unit;
    }
    return '\uFFFD';
  });
}

export function assertBoundedOutput(
  value: string,
  label = 'output',
  maxBytes = MAX_OUTPUT_BYTES
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('output byte limit must be a non-negative safe integer');
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
}

export function stringifyBoundedResult(
  value: unknown,
  label = 'result',
  maxBytes = MAX_OUTPUT_BYTES
): string {
  const text = JSON.stringify(
    value,
    (_key, current: unknown) => {
      if (typeof current === 'number' && !Number.isFinite(current)) {
        throw new Error(`${label} contains a non-finite number`);
      }
      return current;
    },
    2
  );
  if (text === undefined) throw new Error(`${label} is not JSON serializable`);
  assertBoundedOutput(text, label, maxBytes);
  return text;
}

export function containsSensitiveText(value: string): boolean {
  return SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactSensitiveText(value: string): { text: string; redacted: boolean } {
  return containsSensitiveText(value)
    ? { text: REDACTED_SOURCE, redacted: true }
    : { text: value, redacted: false };
}

export function assertSafeForExternalLlm(value: string, label: string): void {
  assertBoundedInput(value, label);
  if (containsSensitiveText(value)) {
    throw new Error(`refusing to send sensitive ${label} to the external LLM`);
  }
}

export function assertNamespaceCount(namespaces: string[] | '*'): void {
  if (namespaces !== '*' && namespaces.length > MAX_NAMESPACE_COUNT) {
    throw new Error(`namespace list exceeds ${MAX_NAMESPACE_COUNT} entries`);
  }
}

export function llmNamespaceAllowlistFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ReadonlySet<string> | undefined {
  const configured = env.REMBERO_LLM_ALLOWED_NAMESPACES;
  if (configured === undefined) return undefined;
  return new Set(
    configured
      .split(',')
      .map((namespace) => namespace.trim())
      .filter(Boolean)
  );
}
