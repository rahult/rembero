export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_NAMESPACE_COUNT = 32;
export const REDACTED_SOURCE = '[sensitive source omitted]';

const SENSITIVE_TEXT_PATTERNS = [
  /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|refresh[_ -]?token|account[_ -]?number|credit[_ -]?card)\b\s*(?:is|=|:)?\s*\S+/i,
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
