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

export async function readMcpPayload(response: Response, requestId?: string | number): Promise<unknown> {
  const matches = (payload: unknown) => requestId === undefined || (
    isRecord(payload) && payload.jsonrpc === "2.0" && payload.id === requestId &&
    (payload.result !== undefined || payload.error !== undefined)
  );
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const raw = await response.text();
    const payload = raw.trim() ? parseJsonOrText(raw) : null;
    return matches(payload) ? payload : null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  let skipLf = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return null;
      pending += decoder.decode(chunk.value, { stream: true });
      // Parse lines incrementally: CR, LF and CRLF are legal, including across chunks.
      while (pending.length) {
        if (skipLf) {
          if (pending.startsWith("\n")) pending = pending.slice(1);
          skipLf = false;
        }
        const end = pending.search(/[\r\n]/);
        if (end === -1) break;
        const line = pending.slice(0, end);
        skipLf = pending[end] === "\r";
        pending = pending.slice(end + 1);
        if (line === "") {
          if (data.length) {
            const payload = parseJsonOrText(data.join("\n"));
            data = [];
            if (matches(payload)) return payload;
          }
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
  } finally {
    // A server may keep the stream open after the result. Never wait for EOF.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
  const requestId = isRecord(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : undefined;
  return { response, payload: await readMcpPayload(response, requestId) };
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
  if (!initialized.response.ok) return null;
  const protocolVersion = jsonRpcResult(initialized.payload)?.protocolVersion;
  // These are the Streamable HTTP revisions supported by this discovery client.
  if (protocolVersion !== "2025-06-18" && protocolVersion !== "2025-03-26") return null;
  const sessionId = initialized.response.headers.get("mcp-session-id");
  // Normalize header names so configured casing cannot duplicate session headers.
  const sessionHeaders = {
    ...Object.fromEntries(new Headers(baseHeaders)),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "mcp-protocol-version": protocolVersion,
  };
  const notification = await mcpPost(input.fetcher, url, sessionHeaders, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  if (notification.response.status !== 202 || notification.payload !== null) return null;
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
