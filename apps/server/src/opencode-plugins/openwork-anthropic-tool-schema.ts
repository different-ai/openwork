/**
 * OpenWork Anthropic Tool Schema Plugin
 *
 * The Anthropic Messages API rejects tool input schemas that use `anyOf`,
 * `oneOf`, or `allOf` at the top level:
 *
 *   tools.N.custom.input_schema: input_schema does not support oneOf, allOf,
 *   or anyOf at the top level
 *
 * Some MCP servers expose such schemas (e.g. PostHog's
 * `file-download-batch-exports-create` uses a top-level `anyOf`), and the
 * bundled OpenCode engine forwards them unchanged, so a single bad tool breaks
 * every chat turn for the whole session.
 *
 * No OpenCode plugin hook can rewrite MCP tool schemas before dispatch, so
 * this plugin patches the engine's global fetch and rewrites Anthropic
 * requests just before they are sent. Requests are detected via the
 * `anthropic-version` header, which @ai-sdk/anthropic always sets. Top-level
 * combinators are merged into a flat object schema; nested combinators are
 * untouched (Anthropic only rejects them at the top level).
 */

const COMBINATOR_KEYS = ["anyOf", "oneOf", "allOf"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function flattenTopLevelCombinators(schema: Record<string, unknown>): Record<string, unknown> {
  const key = COMBINATOR_KEYS.find((k) => Array.isArray(schema[k]));
  if (!key) return schema;
  const rawVariants = schema[key];
  if (!Array.isArray(rawVariants)) return schema;

  const variants = rawVariants.filter(isRecord).map(flattenTopLevelCombinators);
  const properties: Record<string, unknown> = isRecord(schema.properties) ? { ...schema.properties } : {};
  const variantRequired: string[][] = [];
  for (const variant of variants) {
    if (isRecord(variant.properties)) {
      for (const [name, property] of Object.entries(variant.properties)) {
        if (!(name in properties)) properties[name] = property;
      }
    }
    variantRequired.push(stringList(variant.required));
  }

  const baseRequired = stringList(schema.required);
  const mergedRequired =
    key === "allOf"
      ? [...new Set([...baseRequired, ...variantRequired.flat()])]
      : [
          ...new Set([
            ...baseRequired,
            ...(variantRequired[0] ?? []).filter((name) => variantRequired.every((set) => set.includes(name))),
          ]),
        ];

  const result: Record<string, unknown> = { ...schema, type: "object", properties };
  for (const combinator of COMBINATOR_KEYS) delete result[combinator];
  const required = mergedRequired.filter((name) => name in properties);
  if (required.length) result.required = required;
  else delete result.required;

  if (key !== "allOf" && variantRequired.some((set) => set.length)) {
    const hint = variantRequired.map((set) => `(${set.length ? set.join(", ") : "none"})`).join(" or ");
    const description = typeof schema.description === "string" && schema.description ? `${schema.description}\n` : "";
    result.description = `${description}Provide fields matching exactly one input variant; variant required fields: ${hint}.`;
  }
  return result;
}

/** Returns the sanitized JSON body, or null when nothing needed rewriting. */
function sanitizeAnthropicBody(body: string): string | null {
  if (!body.includes("input_schema")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) return null;

  let changed = false;
  const tools = parsed.tools.map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.input_schema)) return tool;
    const sanitized = flattenTopLevelCombinators(tool.input_schema);
    if (sanitized === tool.input_schema) return tool;
    changed = true;
    return { ...tool, input_schema: sanitized };
  });
  if (!changed) return null;
  return JSON.stringify({ ...parsed, tools });
}

function hasAnthropicVersionHeader(headers: RequestInit["headers"]): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has("anthropic-version");
  if (Array.isArray(headers)) return headers.some((entry) => entry[0]?.toLowerCase() === "anthropic-version");
  return Object.keys(headers).some((name) => name.toLowerCase() === "anthropic-version");
}

let installed = false;

function installAnthropicFetchPatch(): void {
  if (installed) return;
  installed = true;
  const base = globalThis.fetch;
  const patched = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    if (init && typeof init.body === "string" && hasAnthropicVersionHeader(init.headers)) {
      const sanitized = sanitizeAnthropicBody(init.body);
      if (sanitized !== null) return base(input, { ...init, body: sanitized });
    }
    return base(input, init);
  };
  globalThis.fetch = Object.assign(patched, base);
}

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OpenWorkAnthropicToolSchema = async () => {
  installAnthropicFetchPatch();
  return {};
};
