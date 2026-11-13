import { ProtocolError, type McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { runMcpServiceAction, type McpAuditPrincipal } from "../audit/mcp-service-audit.js"
import { CATALOG, NativeEventError } from "./protocol.js"
import { createNativeSubscription, subscribeSchema, unsubscribeNative, unsubscribeSchema } from "./service.js"

export function registerNativeMcpEvents(server: McpServer, actor: McpAuditPrincipal, request: Request, canWrite: boolean) {
  const run = async <T>(method: string, name: string | undefined, action: () => Promise<T>) => {
    const expectedName = name && /^[\x20-\x7e]+$/.test(name) ? name : name ? `=?base64?${Buffer.from(name).toString("base64")}?=` : undefined
    const modern = (request.headers.get("mcp-protocol-version") ?? "") >= "2026-07-28"
    if ((modern || request.headers.has("mcp-method")) && request.headers.get("mcp-method") !== method
      || (expectedName && (modern || request.headers.has("mcp-name")) && request.headers.get("mcp-name") !== expectedName)) throw new ProtocolError(-32020, "HeaderMismatch")
    try { return await action() } catch (error) {
      if (error instanceof NativeEventError) throw new ProtocolError(error.code, error.message, error.data)
      if (error instanceof z.ZodError) throw new ProtocolError(-32602, "Invalid event arguments")
      throw new ProtocolError(-32603, "Event operation failed")
    }
  }
  server.server.setRequestHandler("events/list", { params: z.object({ cursor: z.string().optional() }).passthrough() }, () => run("events/list", undefined, async () => ({ resultType: "complete", events: CATALOG })))
  server.server.setRequestHandler("events/subscribe", { params: subscribeSchema }, input => run("events/subscribe", input.name, async () => {
    if (!canWrite) throw new NativeEventError(-32024, "Subscriptions require mcp:write")
    return runMcpServiceAction("native_mcp_event.subscribe", actor, null, () => createNativeSubscription(actor, input))
  }))
  server.server.setRequestHandler("events/unsubscribe", { params: unsubscribeSchema }, input => run("events/unsubscribe", input.name, async () => {
    if (!canWrite) throw new NativeEventError(-32024, "Subscriptions require mcp:write")
    return runMcpServiceAction("native_mcp_event.unsubscribe", actor, null, () => unsubscribeNative(actor, input))
  }))
}
