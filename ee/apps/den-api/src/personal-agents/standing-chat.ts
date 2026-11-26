import { and, desc, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { PersonalAgentChatTurnTable, PersonalAgentConversationTable, PersonalAgentRevisionTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentChatTurn, SendPersonalAgentChatMessage } from "@openwork/types/den/personal-agents"
import { db } from "../db.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps } from "../headless-runner/client.js"
import { mintHeadlessRunMcpToken } from "../mcp/headless-run-token-mint.js"
import { readOrganizationWrittenToolRules } from "../tool-permissions/rules.js"
import { cloudAgentGatewayAccess } from "../workbot/gateway-model.js"
import { personalAgentChatTurnScope } from "../mcp/workbot-turn-limits.js"
import { organizationCloudModelSelection } from "../workbot/model.js"
import type { PersonalAgentAccess, PersonalAgentCaller } from "./access.js"
import { PERSONAL_AGENT_CHAT_TIMEOUT_MS, personalAgentChatDispatchContext } from "./permissions-dispatch.js"

const conversations = PersonalAgentConversationTable
const turns = PersonalAgentChatTurnTable
const HISTORY_LIMIT = 100
const unavailable = "personal_agent_chat_unavailable"
const failed = "personal_agent_chat_failed"

type ChatTurn = typeof turns.$inferSelect
type Actor = PersonalAgentCaller & { userId: string }

function view(turn: ChatTurn): PersonalAgentChatTurn {
  return {
    id: turn.id, clientMessageId: turn.client_message_id, message: turn.message, status: turn.status,
    reply: turn.reply, error: turn.error, createdAt: turn.created_at.toISOString(), finishedAt: turn.finished_at?.toISOString() ?? null,
  }
}

function runner(actor: Actor) {
  const deps = defaultHeadlessRunnerDeps(process.env, { memberId: actor.memberId })
  return deps ? createHeadlessRunnerClient(deps) : null
}

function conversationScope(actor: Actor, agent: PersonalAgentAccess) {
  return and(eq(conversations.organization_id, normalizeDenTypeId("organization", actor.organizationId)),
    eq(conversations.agent_id, normalizeDenTypeId("personalAgent", agent.agentId)),
    eq(conversations.member_id, normalizeDenTypeId("member", actor.memberId)))
}

function sessionId(conversationId: string) {
  return `hs_agent_${conversationId}`
}

function runnerOwner(actor: Actor) {
  return `agent-chat:${actor.organizationId}:${actor.memberId}`
}

async function settle(turn: ChatTurn, outcome: { status: "failed" | "succeeded"; reply: string | null; error: string | null }) {
  await db.update(turns).set({ ...outcome, finished_at: new Date() }).where(and(eq(turns.id, turn.id), eq(turns.status, "running")))
  const [stored] = await db.$primary.select().from(turns).where(eq(turns.id, turn.id)).limit(1)
  return stored ?? turn
}

async function refresh(actor: Actor, turn: ChatTurn) {
  if (turn.status !== "running") return turn
  const client = runner(actor)
  const session = sessionId(turn.conversation_id)
  const read = await client?.readSession(session, { messageId: turn.id, limit: 1, outputs: "none", expectedOwner: runnerOwner(actor) }).catch(() => null)
  if (read?.ok) {
    const status = read.value.turns.find((entry) => entry.messageId === turn.id)?.status
    if (status === "completed") return settle(turn, { status: "succeeded", reply: read.value.finalAssistantText, error: null })
    if (status === "failed" || status === "aborted" || status === "interrupted") {
      return settle(turn, { status: "failed", reply: null, error: failed })
    }
  }
  if (Date.now() - turn.created_at.getTime() < PERSONAL_AGENT_CHAT_TIMEOUT_MS) return turn
  await client?.abort(session, turn.id).catch(() => null)
  return settle(turn, { status: "failed", reply: null, error: unavailable })
}

async function refreshActive(actor: Actor, agent: PersonalAgentAccess) {
  const [active] = await db.$primary.select({ turn: turns }).from(conversations)
    .innerJoin(turns, eq(turns.conversation_id, conversations.id))
    .where(and(conversationScope(actor, agent), eq(turns.status, "running"))).limit(1)
  if (active) await refresh(actor, active.turn)
}

export async function listStandingChat(actor: Actor, agent: PersonalAgentAccess) {
  await refreshActive(actor, agent)
  const rows = await db.$primary.select({ turn: turns }).from(conversations)
    .innerJoin(turns, eq(turns.conversation_id, conversations.id))
    .where(conversationScope(actor, agent)).orderBy(desc(turns.created_at), desc(turns.id)).limit(HISTORY_LIMIT)
  return { turns: rows.reverse().map(({ turn }) => view(turn)) }
}

export async function sendStandingChat(actor: Actor, agent: PersonalAgentAccess, input: SendPersonalAgentChatMessage) {
  await refreshActive(actor, agent)
  const admitted = await db.transaction(async (tx) => {
    const id = createDenTypeId("personalAgentChat")
    await tx.insert(conversations).values({ id, organization_id: normalizeDenTypeId("organization", actor.organizationId),
      agent_id: normalizeDenTypeId("personalAgent", agent.agentId), member_id: normalizeDenTypeId("member", actor.memberId) })
      .onDuplicateKeyUpdate({ set: { id: sql`${conversations.id}` } })
    const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(conversationScope(actor, agent)).limit(1).for("update")
    if (!conversation) throw new Error(unavailable)
    const inConversation = eq(turns.conversation_id, conversation.id)
    const [previous] = await tx.select().from(turns).where(and(inConversation, eq(turns.client_message_id, input.clientMessageId))).limit(1).for("update")
    if (previous) {
      if (previous.message !== input.message) return { error: "personal_agent_chat_idempotency_conflict" }
      return { turn: previous, created: false }
    }
    if (agent.pausedAt !== null) return { error: "personal_agent_paused" }
    const [active] = await tx.select({ id: turns.id }).from(turns).where(and(inConversation, eq(turns.status, "running"))).limit(1).for("update")
    if (active) return { error: "personal_agent_chat_busy" }
    const now = new Date()
    const turn: ChatTurn = { id: createDenTypeId("personalAgentChatTurn"), conversation_id: conversation.id, client_message_id: input.clientMessageId,
      message: input.message, status: "running", reply: null, error: null, finished_at: null, created_at: now, updated_at: now }
    await tx.insert(turns).values(turn)
    return { turn, created: true }
  })
  if (!admitted.turn) return { error: admitted.error }
  if (!admitted.created) return { turn: view(admitted.turn) }
  const { turn } = admitted
  const client = runner(actor)
  if (!client) return { turn: view(await settle(turn, { status: "failed", reply: null, error: unavailable })) }
  let dispatched = false
  try {
    const session = sessionId(turn.conversation_id)
    const [definition] = await db.$primary.select({ name: PersonalAgentTable.name, brief: PersonalAgentRevisionTable.brief })
      .from(PersonalAgentTable).innerJoin(PersonalAgentRevisionTable, eq(PersonalAgentRevisionTable.id, PersonalAgentTable.current_revision_id))
      .where(and(eq(PersonalAgentTable.id, normalizeDenTypeId("personalAgent", agent.agentId)), isNull(PersonalAgentTable.paused_at), eq(PersonalAgentTable.state, "active"))).limit(1)
    const [model, organizationRules] = await Promise.all([
      organizationCloudModelSelection(actor),
      readOrganizationWrittenToolRules(actor.organizationId, { fresh: true }),
    ])
    if (!definition || !model) return { turn: view(await settle(turn, { status: "failed", reply: null, error: unavailable })) }
    const prepared = await client.putSession(session, {
      title: definition.name,
      instructions: `You are ${definition.name}. You are speaking privately with the current member. Follow the organization rules and then the agent brief below. Never claim a connector action completed unless the tool confirms it. If a connector needs approval, explain what is waiting and let the member ask you to continue in a later message.\n\nOrganization rules:\n${organizationRules}\n\nAgent brief:\n${definition.brief}`,
      profile: "agent_chat",
      owner: runnerOwner(actor),
      strict: true,
    })
    const context = prepared.ok && await personalAgentChatDispatchContext(turn.id, actor.organizationId, actor.memberId, actor.userId)
    if (!context || context.paused) return { turn: view(await settle(turn, { status: "failed", reply: null, error: unavailable })) }
    const modelAccess = await cloudAgentGatewayAccess(actor, model)
    if (!modelAccess) return { turn: view(await settle(turn, { status: "failed", reply: null, error: unavailable })) }
    const { token } = await mintHeadlessRunMcpToken({ ...actor, ttlMs: PERSONAL_AGENT_CHAT_TIMEOUT_MS, scopes: [personalAgentChatTurnScope(turn.id)] })
    dispatched = true
    const sent = await client.sendAgentChatTurn({
      sessionId: session, messageId: turn.id, prompt: turn.message, model, modelAccess, agentChatToken: token,
    })
    if (!sent.ok && sent.status < 500) return { turn: view(await settle(turn, { status: "failed", reply: null, error: unavailable })) }
  } catch {
    if (!dispatched) return { turn: view(await settle(turn, { status: "failed", reply: null, error: unavailable })) }
  }
  return { turn: view(turn) }
}
