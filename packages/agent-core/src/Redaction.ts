const secretKey = /authorization|cookie|password|passwd|token|api[_-]?key|secret/i;
export function redactText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function redactSensitiveData<T>(value: T): T {
  const visit = (item: unknown, key?: string): unknown => {
    // Numbers carry no secret, and keys such as inputTokens would otherwise redact usage counts.
    if (key !== undefined && secretKey.test(key) && typeof item !== "number" && typeof item !== "boolean") return "[REDACTED]";
    if (typeof item === "string") return redactText(item);
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(Object.entries(item).map(([entryKey, entry]) => [entryKey, visit(entry, entryKey)]));
  };
  return visit(value) as T;
}
