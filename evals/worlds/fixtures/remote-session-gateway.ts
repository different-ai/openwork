import { denFetch, type DenSession } from "@openwork/behaviors";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("Expected a remote-session response object");
  return value;
}
export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(record)) throw new Error("Expected a remote-session collection");
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a remote-session identity");
  return value;
}

export type GatewayIdentity = { session: DenSession; organizationId?: string };
export type GatewayResult = { isError: boolean; body: Record<string, unknown> };

/** Real first-party tokens and real Den MCP. Never replace capability responses. */
export function remoteSessionGateway(identities: Record<string, GatewayIdentity>) {
  let sequence = 0;
  const tokens = new Map<string, Promise<string>>();
  function identity(persona: string) {
    const value = identities[persona];
    if (!value) throw new Error(`Missing remote-session persona ${persona}`);
    return value;
  }
  async function api(persona: string, path: string, method = "GET", body?: unknown, bearer?: string) {
    const value = identity(persona);
    const result = await denFetch(value.session, path, {
      method,
      headers: {
        authorization: `Bearer ${bearer ?? value.session.token}`,
        ...(value.organizationId ? { "x-openwork-org-id": value.organizationId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.response.status, body: result.body };
  }
  function token(persona: string) {
    let pending = tokens.get(persona);
    if (!pending) {
      pending = api(persona, "/v1/mcp/token", "POST", { scopes: ["mcp:read", "mcp:write"] }).then(result => {
        if (result.status !== 200) throw new Error(`Minting MCP token failed: HTTP ${result.status}`);
        return string(object(result.body).token);
      });
      tokens.set(persona, pending);
    }
    return pending;
  }
  async function call(persona: string, name: string, args: Record<string, unknown>): Promise<GatewayResult> {
    const value = identity(persona);
    const id = ++sequence;
    const response = await fetch(`${value.session.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(persona)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Real Den MCP ${name} failed: HTTP ${response.status}`);
    const envelope = object(await rpcPayload(response, id));
    if (envelope.error !== undefined) throw new Error(`Real Den MCP protocol error: ${JSON.stringify(envelope.error)}`);
    const result = object(envelope.result);
    const text = Array.isArray(result.content) ? result.content.find(part => record(part) && part.type === "text" && typeof part.text === "string") : undefined;
    let body: Record<string, unknown>;
    if (record(result.structuredContent)) body = result.structuredContent;
    else if (record(text) && typeof text.text === "string") body = object(JSON.parse(text.text));
    else throw new Error(`Real Den MCP ${name} returned no structured or JSON text result`);
    return { isError: result.isError === true, body };
  }
  return {
    api, call,
    remote: (persona: string, action: "targets" | "create" | "read" | "list" | "send" | "stop", body: Record<string, unknown>) => call(persona, "execute_capability", { name: `remote-session:${action}`, body }),
    async rollout(enabled: boolean, killed = false) {
      const result = await api("owner", "/v1/admin/features/remoteSessionTargets", "PUT", { enabled, killed });
      if (result.status !== 200) throw new Error(`Remote-session rollout failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
      return result;
    },
  };
}

/** Read the matching SSE frame, not EOF: an MCP stream may remain open. */
async function rpcPayload(response: Response, id: number): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json();
  if (!response.body) throw new Error("Real Den MCP returned no stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Real Den MCP stream ended without its response");
      pending = (pending + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      let edge = pending.indexOf("\n\n");
      while (edge >= 0) {
        const frame = pending.slice(0, edge);
        pending = pending.slice(edge + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) {
          const payload: unknown = JSON.parse(data);
          if (record(payload) && payload.id === id) return payload;
        }
        edge = pending.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
