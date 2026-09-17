import type { DenExternalMcpConnection, DenMcpConnectionConnectStart } from "@/app/lib/den"
import type { UIMessage } from "ai"
import { z } from "zod"
import { connectionCardPayloadFromChatToolResult, connectionResultFromChatToolPart, reconnectActionFromChatToolResult } from "@/components/tools/error-attribution"

export type ChatConnectionDecisionRequest = {
  requestId: string
  owner: string
  sessionId: string
  turnId: string
  toolCallId: string
  connectionId: string
  questionToolCallId?: string
}

export type ChatConnectionDecisionResponse =
  | { outcome: "connected"; continuation: "review_remaining_work"; repeatCompletedWrites: false }
  | { outcome: "skipped"; continuation: "without_connection"; alternativeAuthorization: false }

export type ChatConnectionDecisionBinding = {
  request: ChatConnectionDecisionRequest
  isPending: () => boolean
  respond: (response: ChatConnectionDecisionResponse) => Promise<void>
}

export function isCurrentChatConnectionDecision(
  request: ChatConnectionDecisionRequest,
  owner: string | null,
  sessionId: string,
  messages: readonly UIMessage[],
): boolean {
  if (!owner || request.owner !== owner || request.sessionId !== sessionId || !request.requestId) return false
  const turnIndex = messages.findLastIndex(message => message.role === "user")
  if (turnIndex < 0 || messages[turnIndex].id !== request.turnId) return false
  return messages.slice(turnIndex + 1).some(message => message.role === "assistant"
    && message.parts.some(part => part.type === "dynamic-tool" && part.toolCallId === request.toolCallId))
}

const reservedConnectionQuestionItemSchema = z.object({
  header: z.literal("Connection"),
  options: z.tuple([z.object({ label: z.literal("Authenticate") }), z.object({ label: z.literal("Skip") })]),
  multiple: z.literal(false),
  custom: z.literal(false),
})
const questionItemsSchema = z.object({ questions: z.array(z.unknown()) })

export function isReservedConnectionQuestion(question: unknown): boolean {
  const parsed = questionItemsSchema.safeParse(question)
  return parsed.success && parsed.data.questions.some(item => reservedConnectionQuestionItemSchema.safeParse(item).success)
}

const nativeConnectionQuestionSchema = z.object({
  questions: z.tuple([reservedConnectionQuestionItemSchema.extend({ question: z.string() })]),
  id: z.string().min(1),
  sessionID: z.string().optional(),
  tool: z.object({ callID: z.string().min(1), messageID: z.string().optional() }).optional(),
})

export function nativeChatConnectionDecision(input: {
  question: unknown
  owner: string | null
  sessionId: string
  messages: readonly UIMessage[]
}): ChatConnectionDecisionRequest | null {
  if (!input.owner) return null
  const parsed = nativeConnectionQuestionSchema.safeParse(input.question)
  if (!parsed.success) return null
  const question = parsed.data
  if (question.sessionID !== undefined && question.sessionID !== input.sessionId) return null
  const turnIndex = input.messages.findLastIndex(message => message.role === "user")
  if (turnIndex < 0) return null
  const currentMessages = input.messages.slice(turnIndex + 1).filter(message => message.role === "assistant")
  const questionTool = question.tool
  const questionParts = currentMessages.flatMap(message => message.parts.flatMap(part => {
    if (!questionTool || part.type !== "dynamic-tool" || part.toolName !== "question"
      || (part.state !== "input-available" && part.state !== "input-streaming")
      || (questionTool.messageID && questionTool.messageID !== message.id)) return []
    const sourcePartId = part.callProviderMetadata?.openwork?.sourcePartId
    const matches = part.toolCallId === questionTool.callID
      || (Boolean(questionTool.messageID) && typeof sourcePartId === "string" && sourcePartId === questionTool.callID)
    return matches ? [part.toolCallId] : []
  }))
  if (questionTool && questionParts.length !== 1) return null
  const connections = new Map<string, { connection: NonNullable<ReturnType<typeof connectionCardPayloadFromChatToolResult>>; toolCallId: string; oauth: boolean }>()
  for (const message of currentMessages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || (part.state !== "output-available" && part.state !== "output-error")) continue
      const result = connectionResultFromChatToolPart(part)
      const connection = connectionCardPayloadFromChatToolResult(part.toolName, result, part.input)
      if (!connection) continue
      const action = reconnectActionFromChatToolResult(part.toolName, result, part.input)
      connections.set(connection.connectionId, { connection, toolCallId: part.toolCallId, oauth: action?.connectionId === connection.connectionId })
    }
  }
  const blockers = [...connections.values()].filter(entry => entry.connection.state !== "connected")
  if (blockers.length !== 1) return null
  const blocker = blockers[0]
  if (!blocker.oauth || blocker.connection.actor !== "member"
    || (blocker.connection.action?.type !== "connect" && blocker.connection.action?.type !== "reconnect")
    || question.questions[0].question !== `Connect ${blocker.connection.connectionName} to continue?`) return null
  return {
    requestId: question.id, owner: input.owner, sessionId: input.sessionId,
    turnId: input.messages[turnIndex].id, toolCallId: blocker.toolCallId, connectionId: blocker.connection.connectionId,
    ...(questionParts[0] ? { questionToolCallId: questionParts[0] } : {}),
  }
}

export async function authenticateChatConnection(input: {
  connectionId: string
  connectionName: string
  isCurrent: () => boolean
  listConnections: () => Promise<DenExternalMcpConnection[]>
  startConnect: () => Promise<DenMcpConnectionConnectStart>
  openUrl: (url: string) => Promise<void>
  onProgress: (progress: { phase: "opening" } | { phase: "authorization_opened"; authorizeUrl: string }) => void
}): Promise<"connected"> {
  const assertCurrent = () => {
    if (!input.isCurrent()) throw new Error("The connection request or account changed.")
  }
  assertCurrent()
  const connections = await input.listConnections()
  assertCurrent()
  const connection = connections.find(entry => entry.id === input.connectionId)
  if (!connection || connection.authType !== "oauth" || connection.credentialMode !== "per_member") {
    throw new Error(`${input.connectionName} is no longer available as your reconnectable account.`)
  }
  input.onProgress({ phase: "opening" })
  assertCurrent()
  const result = await input.startConnect()
  assertCurrent()
  if (result.status === "connected") return "connected"
  if (!result.authorizeUrl) throw new Error(`Could not start ${input.connectionName} authorization.`)
  assertCurrent()
  await input.openUrl(result.authorizeUrl)
  assertCurrent()
  input.onProgress({ phase: "authorization_opened", authorizeUrl: result.authorizeUrl })
  assertCurrent()
  await waitForFreshMcpAuthorization({
    connectionId: input.connectionId, connectionName: input.connectionName,
    previousConnectedAt: connection.connectedAt, listConnections: input.listConnections, isScopeCurrent: input.isCurrent,
  })
  assertCurrent()
  return "connected"
}

export const CHAT_MCP_RECONNECT_POLL_INTERVAL_MS = 2_000
export const CHAT_MCP_RECONNECT_TIMEOUT_MS = 90_000

export type ChatMcpReconnectScope = {
  baseUrl: string
  token: string
  organizationId: string
}

export function isChatMcpReconnectScopeCurrent(
  expected: ChatMcpReconnectScope,
  current: ChatMcpReconnectScope,
): boolean {
  return expected.baseUrl === current.baseUrl
    && expected.token === current.token
    && expected.organizationId === current.organizationId
}

export function hasFreshMcpAuthorization(
  connection: Pick<DenExternalMcpConnection, "connectedForMe" | "connectedAt"> | null | undefined,
  previousConnectedAt: string | null,
): boolean {
  return connection?.connectedForMe === true
    && typeof connection.connectedAt === "string"
    && connection.connectedAt.length > 0
    && connection.connectedAt !== previousConnectedAt
}

export async function waitForFreshMcpAuthorization(input: {
  connectionId: string
  connectionName: string
  previousConnectedAt: string | null
  listConnections: () => Promise<DenExternalMcpConnection[]>
  isScopeCurrent: () => boolean
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<DenExternalMcpConnection> {
  const timeoutMs = input.timeoutMs ?? CHAT_MCP_RECONNECT_TIMEOUT_MS
  const intervalMs = input.intervalMs ?? CHAT_MCP_RECONNECT_POLL_INTERVAL_MS
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)))
  const startedAt = now()

  while (now() - startedAt < timeoutMs) {
    if (!input.isScopeCurrent()) {
      throw new Error("The active OpenWork Cloud account changed while reconnecting. Try again in this workspace.")
    }
    try {
      const connections = await input.listConnections()
      if (!input.isScopeCurrent()) {
        throw new Error("The active OpenWork Cloud account changed while reconnecting. Try again in this workspace.")
      }
      const connection = connections.find((entry) => entry.id === input.connectionId)
      if (connection && hasFreshMcpAuthorization(connection, input.previousConnectedAt)) return connection
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The active OpenWork Cloud account changed")) throw error
      // A transient list failure should not turn a successful browser callback
      // into a false failure. Keep polling until the bounded timeout.
    }
    await sleep(intervalMs)
  }

  throw new Error(`Authorization for ${input.connectionName} did not finish. Complete it in the browser, then try reconnecting again.`)
}
