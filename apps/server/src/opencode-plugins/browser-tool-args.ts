export function coerceJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

const NESTED_JSON_ARG_KEYS = ["action", "actions", "input", "query"] as const;

export function coerceNestedJsonArgs(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value;
  }
  for (const key of NESTED_JSON_ARG_KEYS) {
    if (!(key in out)) {
      continue;
    }
    const value = out[key];
    if (key === "actions" && Array.isArray(value)) {
      out[key] = value.map(coerceJsonValue);
      continue;
    }
    out[key] = coerceJsonValue(value);
  }
  return out;
}

export function singleActionAsList(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("action" in raw)) {
    return raw;
  }
  if ("actions" in raw) {
    throw new Error("Pass every step in actions, not in both action and actions.");
  }
  const { action, ...rest } = raw;
  return { ...rest, actions: [coerceJsonValue(action)] };
}
