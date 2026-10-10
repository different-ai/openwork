import { createHash } from "node:crypto"
import { type McpServer, ProtocolError, ProtocolErrorCode, ResourceTemplate } from "@modelcontextprotocol/server"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { RemoteSessionCommandStore } from "../remote-sessions/commands.js"
import type { RemoteSessionRequestStore } from "../remote-sessions/requests.js"

export const REMOTE_SESSION_RECEIPT_ROOT = "openwork://remote-sessions"
export const REMOTE_SESSION_RECEIPT_INSTRUCTIONS = "Remote session receipts are private, uncached resources. With protocol 2026-07-28, subscribe using subscriptions/listen params.notifications.resourceSubscriptions with exact statusResourceUri values. Wait for notifications/subscriptions/acknowledged, then immediately resources/read each URI (also after reconnecting). notifications/resources/updated only invalidates that URI: read it again for current state. There is no replay, event payload, runner dispatch, or Tasks API. Poll remote-session:read when subscriptions are unavailable."

export type RemoteSessionReceiptScope = { organizationId: string; createdByUserId: string }
export type RemoteSessionReceiptStores = {
  commandStore: Pick<RemoteSessionCommandStore, "get">
  requestStore: Pick<RemoteSessionRequestStore, "get">
}

export function remoteSessionReceiptUri(kind: "commands" | "requests", id: string): string {
  return `${REMOTE_SESSION_RECEIPT_ROOT}/${kind}/${id}`
}

/** Exact canonical URIs only: no query, fragment, encoding, alternate host or wildcard. */
export function parseRemoteSessionReceiptUri(uri: string) {
  const match = /^openwork:\/\/remote-sessions\/(commands|requests)\/([a-z0-9_]+)$/.exec(uri)
  if (!match) return null
  const kind = match[1] === "commands" ? "commands" : "requests"
  try {
    const id = normalizeDenTypeId(kind === "commands" ? "remoteSessionCommand" : "remoteSessionRequest", match[2] ?? "")
    return remoteSessionReceiptUri(kind, id) === uri ? { kind, id } : null
  } catch {
    return null
  }
}

export function remoteSessionReceiptUnavailable(): ProtocolError {
  // Unknown and foreign receipts deliberately have the same response.
  return new ProtocolError(ProtocolErrorCode.InvalidParams, "Remote session receipt is unavailable.")
}

function receiptFingerprint(text: string): string {
  // Watchers retain only a fixed-size fingerprint, not another copy of a transcript.
  return createHash("sha256").update(text).digest("hex")
}

/** Shared by resources/read and each replica's live watcher. Never fetch by id alone. */
export async function readRemoteSessionReceipt(input: RemoteSessionReceiptStores & RemoteSessionReceiptScope & { uri: string }) {
  const receipt = parseRemoteSessionReceiptUri(input.uri)
  if (!receipt) throw remoteSessionReceiptUnavailable()
  const scope = { organizationId: input.organizationId, createdByUserId: input.createdByUserId }
  if (receipt.kind === "commands") {
    const command = await input.commandStore.get({ ...scope, commandId: receipt.id })
    if (!command || command.id !== receipt.id || command.organizationId !== scope.organizationId || command.createdByUserId !== scope.createdByUserId) throw remoteSessionReceiptUnavailable()
    const projection = {
      commandId: command.id,
      target: "desktop",
      state: command.status,
      targetComputerId: command.targetComputerId,
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      resultSummary: command.resultSummary,
      error: command.error,
      expiresAt: command.expiresAt,
      session: command.session,
    }
    // Progress heartbeats alone are not changes. Keep the full timestamp on reads.
    const stableSession = command.session ? { ...command.session, observedAt: undefined } : null
    return { text: JSON.stringify(projection), fingerprint: receiptFingerprint(JSON.stringify({ ...projection, session: stableSession })) }
  }
  const request = await input.requestStore.get({ ...scope, requestId: receipt.id })
  if (!request || request.id !== receipt.id || request.organizationId !== scope.organizationId || request.createdByUserId !== scope.createdByUserId) throw remoteSessionReceiptUnavailable()
  const projection = {
    requestId: request.id,
    commandId: request.commandId,
    target: "desktop",
    action: request.action,
    state: request.status,
    sessionId: request.sessionId,
    workspaceId: request.workspaceId,
    outcome: request.outcome,
    error: request.error,
    expiresAt: request.expiresAt,
  }
  const text = JSON.stringify(projection)
  return { text, fingerprint: receiptFingerprint(text) }
}

export function registerRemoteSessionReceiptResources(input: RemoteSessionReceiptStores & RemoteSessionReceiptScope & { server: McpServer }) {
  const kinds: ("commands" | "requests")[] = ["commands", "requests"]
  for (const kind of kinds) {
    input.server.registerResource(`remote-session-${kind}`, new ResourceTemplate(`${REMOTE_SESSION_RECEIPT_ROOT}/${kind}/{id}`, { list: undefined }), {
      title: kind === "commands" ? "Remote session command receipt" : "Remote session request receipt",
      description: REMOTE_SESSION_RECEIPT_INSTRUCTIONS,
      mimeType: "application/json",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: (await readRemoteSessionReceipt({ ...input, uri: uri.href })).text }],
    }))
  }
}

/** Pure, gated decoration: never perform extra database work after a durable mutation. */
export function withRemoteSessionReceiptUri<T extends { structuredContent?: Record<string, unknown> }>(result: T, enabled: boolean): T & { structuredContent?: Record<string, unknown> } {
  const content = result.structuredContent
  if (!enabled || !content || (content.target !== "desktop" && content.target !== "registered")) return result
  const kind = typeof content.requestId === "string" ? "requests" : "commands"
  const id = kind === "requests" ? content.requestId : content.commandId
  if (typeof id !== "string") return result
  const statusResourceUri = remoteSessionReceiptUri(kind, id)
  if (!parseRemoteSessionReceiptUri(statusResourceUri)) return result
  // structuredContent is the machine-readable result; leave original tool text intact.
  return { ...result, structuredContent: { ...content, statusResourceUri } }
}
