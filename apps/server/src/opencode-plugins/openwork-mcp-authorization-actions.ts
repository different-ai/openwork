const AUTHORIZATION_REQUIRED_CODE = -32001;
const AUTHORIZATION_ACTION_MARKER = "[OpenWork authorization action]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const markdownDestination = /^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i.exec(trimmed)?.[1];
  const candidate = markdownDestination ?? trimmed;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function structuredAuthorizationError(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    return isRecord(parsed.error) ? parsed.error : parsed;
  } catch {
    return null;
  }
}

function hasAuthorizationRequiredCode(errorText: string): boolean {
  const structured = structuredAuthorizationError(errorText);
  if (structured?.code === AUTHORIZATION_REQUIRED_CODE) return true;
  return /(?:MCP\s+error|["']?code["']?\s*[:=])\s*-32001(?!\d)/i.test(errorText);
}

function structuredConnectUrl(errorText: string): string | null {
  const error = structuredAuthorizationError(errorText);
  if (!error || !isRecord(error.data)) return null;
  return safeHttpUrl(error.data.connect_url);
}

function connectUrlFromText(errorText: string): string | null {
  const structured = structuredConnectUrl(errorText);
  if (structured) return structured;

  for (const match of errorText.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gi)) {
    const url = safeHttpUrl(match[1]);
    if (url) return url;
  }

  for (const match of errorText.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = safeHttpUrl(match[0].replace(/[.,;]+$/, ""));
    if (url) return url;
  }

  return null;
}

function authorizationAction(errorText: string): string | null {
  if (errorText.includes(AUTHORIZATION_ACTION_MARKER)) return null;
  if (!hasAuthorizationRequiredCode(errorText)) return null;
  const connectUrl = connectUrlFromText(errorText);
  if (!connectUrl) return null;
  return [
    AUTHORIZATION_ACTION_MARKER,
    "This MCP connector needs user authorization.",
    `Tell the user which connector needs authorization and present this exact URL as a Markdown link: ${connectUrl}`,
    "Wait for the user to connect before retrying. Do not open the URL yourself.",
  ].join("\n");
}

function transformPart(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "tool" || !isRecord(value.state)) return value;
  if (value.state.status !== "error" || typeof value.state.error !== "string") return value;
  const action = authorizationAction(value.state.error);
  if (!action) return value;
  return {
    ...value,
    state: {
      ...value.state,
      error: `${value.state.error}\n\n${action}`,
    },
  };
}

function transformMessage(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.parts)) return value;
  return { ...value, parts: value.parts.map(transformPart) };
}

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OpenWorkMcpAuthorizationActions = async () => ({
  "experimental.chat.messages.transform": async (input: unknown, output: { messages: unknown[] }) => {
    void input;
    const messages = output.messages.map(transformMessage);
    output.messages.splice(0, output.messages.length, ...messages);
  },
});
