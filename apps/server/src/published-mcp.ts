// Minimal MCP Streamable HTTP transport for the published-workflows feature.
// Implements only the JSON-RPC subset needed for stateless tool servers:
//   initialize, notifications/initialized, tools/list, tools/call.
//
// Spec reference: https://modelcontextprotocol.io/specification (2024-11-05)
// We intentionally do NOT support SSE upgrades or session IDs; each POST is
// stateless and returns a JSON-RPC response in a single HTTP turn.

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "openwork-published-workflow", version: "0.1.0" } as const;

export type McpToolInputSchema = {
  type: "object";
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
};

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
};

export type McpExecuteResult = { text: string; isError?: boolean };

export type McpExecuteFn = (args: Record<string, unknown>) => Promise<McpExecuteResult>;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcSuccess = { jsonrpc: "2.0"; id: JsonRpcId; result: unknown };
type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function jsonRpcResponse(body: JsonRpcSuccess | JsonRpcError, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function success(id: JsonRpcId, result: unknown): Response {
  return jsonRpcResponse({ jsonrpc: "2.0", id, result });
}

function error(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  return jsonRpcResponse({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === "2.0" && typeof v.method === "string";
}

export async function handleMcpRequest(input: {
  request: Request;
  tool: McpToolDescriptor;
  execute: McpExecuteFn;
}): Promise<Response> {
  const { request, tool, execute } = input;

  if (request.method === "GET" || request.method === "HEAD") {
    // SSE transport not supported in this minimal handler.
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (request.method === "DELETE") {
    // Stateless server: nothing to terminate.
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(null, PARSE_ERROR, "Parse error");
  }
  if (!isJsonRpcRequest(body)) {
    return error(null, INVALID_REQUEST, "Invalid Request");
  }

  const id: JsonRpcId = body.id ?? null;
  const isNotification = body.id === undefined;

  switch (body.method) {
    case "initialize": {
      return success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled": {
      return new Response(null, { status: 202 });
    }
    case "ping": {
      return success(id, {});
    }
    case "tools/list": {
      return success(id, { tools: [tool] });
    }
    case "tools/call": {
      const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string" || params.name !== tool.name) {
        return error(id, INVALID_PARAMS, `Unknown tool: ${String(params.name ?? "")}`);
      }
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await execute(args);
        return success(id, {
          content: [{ type: "text", text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Tool execution failed";
        return success(id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }
    default: {
      if (isNotification) return new Response(null, { status: 202 });
      return error(id, METHOD_NOT_FOUND, `Method not found: ${body.method}`);
    }
  }
}

export const McpErrorCodes = {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} as const;
