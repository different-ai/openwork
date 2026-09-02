/**
 * OpenWork OpenAI-Compatible System Prompt Plugin
 *
 * Strict OpenAI-compatible servers accept exactly one system message, at index
 * 0. vLLM serving a Qwen chat template is the common case, and that is what
 * most European inference providers run, so a second system message is
 * rejected outright:
 *
 *   {"error":{"message":"System message must be at the beginning.",
 *             "type":"BadRequestError","code":400}}
 *
 * OpenWork reliably sends more than one. `openwork-capabilities-knowledge` and
 * `openwork-extensions-preview` each append to `output.system` in
 * `experimental.chat.system.transform`, and `@ai-sdk/openai-compatible`
 * serialises every array entry as its own `{"role":"system"}` message, so a
 * request from the `openwork` agent carries three to five of them and fails on
 * the first turn of a new session.
 *
 * Merging inside those plugins only works if their transforms happen to run
 * last (see #2339), and a normalizer plugin registered late is still defeated
 * by a user-installed plugin registered after it. This plugin therefore
 * flattens at the wire boundary instead, patching the engine's global fetch
 * the same way `openwork-anthropic-tool-schema` does. That is order-independent
 * by construction and also covers third-party plugins.
 *
 * Anthropic requests are excluded, detected via the `anthropic-version` header:
 * there the array form is deliberate, because each entry becomes its own system
 * block with its own cache breakpoint.
 *
 * Only the leading run is merged. A system message that appears after a user or
 * assistant message is left in place; that would be a different bug, and
 * silently reordering it would change the conversation the model sees.
 */

const SYSTEM_ROLE = "system";
const JOIN = "\n\n";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSystemMessage(value: unknown): value is JsonRecord {
  return isRecord(value) && value.role === SYSTEM_ROLE;
}

/** Number of consecutive system messages at the head of the list. */
function leadingSystemCount(messages: unknown[]): number {
  let count = 0;
  while (count < messages.length && isSystemMessage(messages[count])) count += 1;
  return count;
}

/**
 * Merge the `content` fields of several system messages. Content is either a
 * plain string or an array of content parts, and the two forms can be mixed
 * within one request. Strings are joined by a blank line; as soon as any part
 * array is involved the result stays an array so no structured part is
 * flattened away.
 */
function mergeContent(messages: JsonRecord[]): unknown {
  const anyArray = messages.some((message) => Array.isArray(message.content));
  if (!anyArray) {
    return messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .filter((text) => text.length > 0)
      .join(JOIN);
  }
  const parts: unknown[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) parts.push(...message.content);
    else if (typeof message.content === "string" && message.content.length > 0) {
      parts.push({ type: "text", text: message.content });
    }
  }
  return parts;
}

/**
 * Returns the rewritten body, or null when nothing needed changing so the
 * caller can forward the original string untouched.
 */
function collapseLeadingSystemMessages(body: string): string | null {
  if (!body.includes(`"${SYSTEM_ROLE}"`)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return null;

  const messages = parsed.messages;
  const count = leadingSystemCount(messages);
  if (count < 2) return null;

  const head = messages.slice(0, count) as JsonRecord[];
  const merged: JsonRecord = { ...head[0], content: mergeContent(head) };
  return JSON.stringify({ ...parsed, messages: [merged, ...messages.slice(count)] });
}

function hasAnthropicVersionHeader(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has("anthropic-version");
  if (Array.isArray(headers)) {
    return headers.some((entry) => entry[0]?.toLowerCase() === "anthropic-version");
  }
  return Object.keys(headers).some((name) => name.toLowerCase() === "anthropic-version");
}

let installed = false;

function installOpenAiCompatibleFetchPatch(): void {
  if (installed) return;
  installed = true;
  const base = globalThis.fetch;
  const patched: typeof fetch = async (input, init) => {
    if (init && typeof init.body === "string" && !hasAnthropicVersionHeader(init.headers)) {
      const collapsed = collapseLeadingSystemMessages(init.body);
      if (collapsed !== null) return base(input, { ...init, body: collapsed });
    }
    return base(input, init);
  };
  globalThis.fetch = Object.assign(patched, base);
}

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OpenWorkOpenAiCompatibleSystem = async () => {
  installOpenAiCompatibleFetchPatch();
  return {};
};
