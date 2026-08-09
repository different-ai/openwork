// Minimal Streamable-HTTP MCP client used to read discovery resources from an
// openwork-cloud connection. Extracted from connect-skill-catalog so the skill
// index and the Automation index speak to the same connection the same way.
export type McpFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function parseJsonOrText(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

export async function readMcpPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) return null;
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return parseJsonOrText(raw);
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) return parseJsonOrText(data);
  }
  return null;
}

export function jsonRpcResult(payload: unknown): Record<string, unknown> | null {
  const record = Array.isArray(payload) ? payload.find(isRecord) : payload;
  if (!isRecord(record) || record.error !== undefined || !isRecord(record.result)) return null;
  return record.result;
}

export async function mcpPost(fetcher: McpFetch, url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  return { response, payload: await readMcpPayload(response) };
}

/**
 * Reads one JSON resource from an openwork-cloud config. Returns the resource
 * text, or null when the config is unusable (invalid URL, disabled, auth
 * rejected, transport or protocol error) so callers can try another candidate.
 */
export async function readMcpResourceText(input: {
  config: Record<string, unknown>;
  uri: string;
  fetcher: McpFetch;
  clientName: string;
}): Promise<string | null> {
  const url = typeof input.config.url === "string" ? input.config.url : "";
  if (!/^https?:\/\//.test(url) || input.config.enabled === false) return null;
  const baseHeaders = stringHeaders(input.config.headers);
  const initialized = await mcpPost(input.fetcher, url, baseHeaders, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: input.clientName, version: "1.0.0" },
      protocolVersion: "2025-06-18",
    },
  });
  if (!initialized.response.ok || !jsonRpcResult(initialized.payload)) return null;
  const sessionHeaders = {
    ...baseHeaders,
    ...(initialized.response.headers.get("mcp-session-id") ? { "mcp-session-id": initialized.response.headers.get("mcp-session-id")! } : {}),
    ...(initialized.response.headers.get("mcp-protocol-version") ? { "mcp-protocol-version": initialized.response.headers.get("mcp-protocol-version")! } : {}),
  };
  await mcpPost(input.fetcher, url, sessionHeaders, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const resource = await mcpPost(input.fetcher, url, sessionHeaders, {
    id: 2,
    jsonrpc: "2.0",
    method: "resources/read",
    params: { uri: input.uri },
  });
  if (!resource.response.ok) return null;
  const contents = jsonRpcResult(resource.payload)?.contents;
  if (!Array.isArray(contents)) return null;
  const text = contents.find((item) => isRecord(item) && item.uri === input.uri && typeof item.text === "string")?.text;
  return typeof text === "string" ? text : null;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
