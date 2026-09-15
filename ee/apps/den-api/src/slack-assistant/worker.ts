import { organizeSlackSession, renameSlackSession, slackSessionNeedsAttention } from "./runtime.js"
import { checkpointSchema, advanceSlackRun, stopSlackStream, RemoteSessionUnavailableError } from "./run.js"
import { z } from "zod"
import { appLogger } from "../observability/logger.js"
import { openworkYourConnectionsUrl } from "../mcp/connection-navigation.js"
import { executeRemoteSessionCapability, type RemoteSessionAction } from "../mcp/remote-session-capabilities.js"
import { buildSlackPrompt, SlackApiError, slackClient, slackEventSchema } from "./protocol.js"
import {
  slackAssistantEnabledForInstallation,
  admitSlackRun,
  latestSlackContext,
  findSlackThread,
  removeSlackIdentities,
  persistSlackCheckpoint,
  cancelSlackThread,
  checkpointEvent,
  claimSlackEvent,
  getInstallation,
  lockSlackThread,
  releaseSlackThread,
  resolveSlackActor,
  revokeSlackInstallation,
  saveSlackSession,
  type EventRow,
  type SlackActor,
} from "./repository.js"
import { pruneSlackEvents, renewSlackLease, SlackLeaseLostError } from "./repository.js"

async function remoteCall(actor: SlackActor, action: RemoteSessionAction, body: Record<string, unknown>) {
  const result = await executeRemoteSessionCapability({
    action,
    body,
    organizationId: actor.organizationId,
    userId: actor.userId,
    hasWriteScope: true,
  })
  return result.structuredContent ?? {}
}

const defaultWorkerDeps = {
  slack: slackClient,
  remote: remoteCall,
  organize: organizeSlackSession,
  needsAttention: slackSessionNeedsAttention,
  rename: renameSlackSession,
}
export async function processSlackEvent(event: EventRow, suppliedDeps = defaultWorkerDeps) {
  await renewSlackLease(event)
  const deps: typeof defaultWorkerDeps = {
    slack: (token) => async (method, body) => {
      await renewSlackLease(event)
      return suppliedDeps.slack(token)(method, body)
    },
    remote: async (actor, action, body) => {
      await renewSlackLease(event)
      return suppliedDeps.remote(actor, action, body)
    },
    organize: async (actor, session) => {
      await renewSlackLease(event)
      return suppliedDeps.organize(actor, session)
    },
    needsAttention: async (actor, session) => {
      await renewSlackLease(event)
      return suppliedDeps.needsAttention(actor, session)
    },
    rename: async (actor, session, title) => {
      await renewSlackLease(event)
      return suppliedDeps.rename(actor, session, title)
    },
  }
  const installation = await getInstallation(event.connectionId)
  const payload = slackEventSchema.parse(JSON.parse(event.payload))
  if (!installation?.botToken) {
    await releaseSlackThread(event)
    return checkpointEvent(event, { status: "done" })
  }
  const slack = deps.slack(installation.botToken)
  if (payload.type === "app_uninstalled") {
    await revokeSlackInstallation(event.connectionId)
    return checkpointEvent(event, { status: "done" })
  }
  if (payload.type === "agent_session_stopped") {
    await cancelSlackThread(installation, payload)
    return checkpointEvent(event, { status: "done" })
  }
  if (payload.type === "tokens_revoked") {
    if (payload.tokens?.bot?.includes(installation.botUserId ?? "")) await revokeSlackInstallation(event.connectionId)
    else await removeSlackIdentities(event.connectionId, payload.tokens?.oauth ?? [])
    return checkpointEvent(event, { status: "done" })
  }
  if (payload.type === "app_home_opened") {
    if (payload.user && payload.tab === "home")
      await slack("views.publish", {
        user_id: payload.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Your own OpenWork assistant. Connect your Slack account, then mention @openwork or send a message here.",
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  action_id: "connect_openwork",
                  text: { type: "plain_text", text: "Connect OpenWork" },
                  url: openworkYourConnectionsUrl(event.connectionId),
                },
              ],
            },
          ],
        },
      })
    if (payload.channel && payload.tab === "messages")
      await slack("assistant.threads.setSuggestedPrompts", {
        channel_id: payload.channel,
        prompts: [
          { title: "Connect my OpenWork", message: "Connect my OpenWork" },
          { title: "Summarize this channel", message: "Summarize this channel" },
          { title: "What did I miss today?", message: "What did I miss today?" },
          { title: "Draft a reply", message: "Draft a reply to this thread" },
        ],
      })
    return checkpointEvent(event, { status: "done" })
  }
  if (payload.type === "app_context_changed") return checkpointEvent(event, { status: "context" })
  const cp = checkpointSchema.parse(event.checkpoint ? JSON.parse(event.checkpoint) : {})
  const actor = await resolveSlackActor(installation, event.slackUserId)
  if (!actor) {
    if (
      event.status === "running" ||
      !installation.enabled ||
      !(await slackAssistantEnabledForInstallation(installation))
    ) {
      if (cp.streamTs) {
        try {
          await stopSlackStream(slack, { ...cp, finalStatus: "suspended" })
        } catch {
          /* Revoked bot credentials cannot clear Slack status. */
        }
      }
      await releaseSlackThread(event)
      return checkpointEvent(event, { status: "done" })
    }
    await slack("chat.postEphemeral", {
      channel: event.channelId,
      user: event.slackUserId,
      thread_ts: event.threadTs,
      text: "I run on your own OpenWork workspace. Connect once to get started.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "I run on your own OpenWork workspace. Connect your Slack account to continue. Your workspace must grant access to this connection and OpenWork Web.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Connect OpenWork" },
              url: openworkYourConnectionsUrl(event.connectionId),
              action_id: "connect_openwork",
            },
          ],
        },
      ],
    })
    return checkpointEvent(event, { status: "awaiting_link" })
  }
  if (payload.type === "agent_session_title_changed") {
    const existing = await findSlackThread(event, actor)
    if (existing?.sessionId && payload.title) await deps.rename(actor, existing.sessionId, payload.title)
    return checkpointEvent(event, { status: "done" })
  }
  const thread = await lockSlackThread(event, actor)
  if (!thread) return checkpointEvent(event, {}, 2_000)
  if (event.cancelled || Date.now() - event.createdAt.getTime() > 15 * 60_000) {
    if (cp.sessionId && cp.phase !== "create")
      await deps.remote(actor, "stop", { sessionId: cp.sessionId, messageId: `msg_${event.id}` })
    if (cp.streamTs)
      await stopSlackStream(
        slack,
        { ...cp, finalStatus: "suspended" },
        { chunks: [{ type: "markdown_text", text: "\n\nStopped. Open OpenWork Web to continue." }] },
      )
    await releaseSlackThread(event)
    return checkpointEvent(event, { status: "done" })
  }
  if (cp.phase === "create" && !cp.prompt) {
    if (!(await admitSlackRun(event, installation))) {
      await slack("chat.postEphemeral", {
        channel: event.channelId,
        user: event.slackUserId,
        text: "OpenWork Slack has paused new requests because of a usage limit or repeated service failures. Please use OpenWork Web or try again later.",
      })
      await releaseSlackThread(event)
      return checkpointEvent(event, { status: "done" })
    }
    // Validate the live user credential again before accepting a new turn.
    const identity = await deps.slack(actor.userToken)("auth.test", {})
    if (identity.user_id !== event.slackUserId || identity.team_id !== event.teamId || identity.bot_id)
      throw new Error("slack_actor_mismatch")
    cp.recipientUserId = event.slackUserId
    cp.recipientTeamId = event.teamId
    cp.privateReply =
      payload.channel_type === "im" || installation.shadowMode || /(^|\s)--private(?=\s|$)/.test(payload.text ?? "")
    cp.channel ??= event.channelId
    cp.threadTs ??= event.threadTs
    if (cp.privateReply && payload.channel_type !== "im" && cp.channel === event.channelId) {
      const dm = z
        .object({ channel: z.object({ id: z.string() }) })
        .parse(await slack("conversations.open", { users: event.slackUserId }))
      const root = z
        .object({ ts: z.string() })
        .parse(await slack("chat.postMessage", { channel: dm.channel.id, text: "Your private OpenWork reply" }))
      cp.channel = dm.channel.id
      cp.threadTs = root.ts
    }
    if (!cp.streamTs) {
      await slack("agents.sessions.setStatus", {
        channel_id: cp.channel,
        thread_ts: cp.threadTs,
        status: "processing",
        initiator_user_id: event.slackUserId,
        title: "OpenWork task",
      })
      const stream = z.object({ ts: z.string() }).parse(
        await slack("chat.startStream", {
          channel: cp.channel,
          thread_ts: cp.threadTs,
          recipient_user_id: event.slackUserId,
          recipient_team_id: event.teamId,
          chunks: [{ type: "markdown_text", text: "OpenWork task\n\n" }],
          task_display_mode: "timeline",
        }),
      )
      cp.streamTs = stream.ts
      await persistSlackCheckpoint(event, cp)
    }
    // Fetch with the member's token: bot access must never widen what the actor sees.
    let context: unknown = { unavailable: true, instruction: "Read the relevant thread using your Slack connection." }
    try {
      context = await deps.slack(actor.userToken)("conversations.replies", {
        channel: event.channelId,
        ts: event.threadTs,
        limit: 30,
      })
    } catch {
      /* Agent can use the member's MCP tools. */
    }
    if (!payload.app_context) {
      const latest = await latestSlackContext(event)
      if (latest) payload.app_context = slackEventSchema.parse(JSON.parse(latest)).app_context
    }
    cp.prompt = buildSlackPrompt({
      event: payload,
      teamId: event.teamId,
      botUserId: installation.botUserId ?? "",
      context,
      privateReply: cp.privateReply,
    })
    cp.sessionId = thread.sessionId ?? undefined
    cp.workspaceId = thread.workspaceId ?? undefined
    await checkpointEvent(event, { status: "running", checkpoint: JSON.stringify(cp) })
    return
  }
  cp.sessionId ??= thread.sessionId ?? undefined
  cp.workspaceId ??= thread.workspaceId ?? undefined
  const result = await advanceSlackRun({
    checkpoint: cp,
    slack,
    remote: (action, body) => deps.remote(actor, action, body),
    messageId: `msg_${event.id}`,
    saveSession: async (sessionId, workspaceId) => {
      await renewSlackLease(event)
      await saveSlackSession(thread.id, sessionId, workspaceId)
      await deps.organize(actor, sessionId)
    },
    needsAttention: (sessionId) => deps.needsAttention(actor, sessionId),
    persist: (checkpoint) => persistSlackCheckpoint(event, checkpoint),
    title: `${event.channelId} · ${(payload.text ?? "Task").slice(0, 85)}`,
  })
  if (result.done) await releaseSlackThread(event)
  await checkpointEvent(
    event,
    { status: result.done ? "done" : "running", checkpoint: JSON.stringify(result.checkpoint) },
    result.delayMs,
  )
  if (result.done)
    appLogger.info("slack_assistant_completed", {
      event_id: event.id,
      elapsed_ms: Date.now() - event.createdAt.getTime(),
    })
}

export async function handleSlackEventFailure(event: EventRow, error: unknown, deps = defaultWorkerDeps) {
  if (error instanceof SlackLeaseLostError) return
  const stopped = error instanceof SlackApiError && error.code === "stopped_by_user"
  const permanent =
    error instanceof RemoteSessionUnavailableError ||
    (error instanceof SlackApiError &&
      ["invalid_auth", "token_revoked", "account_inactive", "missing_scope", "channel_not_found"].includes(error.code))
  if (!stopped && !permanent && event.attempts < 20) {
    await checkpointEvent(
      event,
      { attempts: event.attempts + 1 },
      error instanceof SlackApiError && error.retryAfterMs ? error.retryAfterMs : 10_000,
    )
    return
  }
  await renewSlackLease(event)
  const installation = await getInstallation(event.connectionId)
  const cp = checkpointSchema.parse(event.checkpoint ? JSON.parse(event.checkpoint) : {})
  if (installation) {
    const actor = await resolveSlackActor(installation, event.slackUserId)
    if (actor && cp.sessionId) {
      try {
        await deps.remote(actor, "stop", { sessionId: cp.sessionId, messageId: `msg_${event.id}` })
      } catch {
        /* Runtime may be unreachable. */
      }
    }
    if (installation.botToken && cp.streamTs) {
      try {
        await stopSlackStream(
          deps.slack(installation.botToken),
          { ...cp, finalStatus: "suspended" },
          {
            chunks: [{ type: "markdown_text", text: "\n\nThis task stopped. Open OpenWork Web to continue." }],
          },
        )
      } catch {
        /* Slack may already have stopped the stream or revoked the bot. */
      }
    }
  }
  await releaseSlackThread(event)
  await checkpointEvent(event, { status: stopped ? "done" : "failed" })
}

export function startSlackAssistantWorker() {
  if (process.env.DEN_SLACK_ASSISTANT_WORKER_ENABLED === "false") return async () => {}
  let stopped = false
  let ticking = false
  let lastPruned = 0
  const tick = async () => {
    if (stopped || ticking) return
    ticking = true
    try {
      if (Date.now() - lastPruned > 300_000) {
        await pruneSlackEvents()
        lastPruned = Date.now()
      }
      const events: EventRow[] = []
      for (let i = 0; i < 8; i++) {
        const event = await claimSlackEvent()
        if (!event) break
        events.push(event)
      }
      await Promise.all(
        events.map(async (event) => {
          try {
            await processSlackEvent(event)
          } catch (error) {
            appLogger.warn("slack_assistant_event_failed", {
              event_id: event.id,
              attempt: event.attempts,
              code: error instanceof SlackApiError ? error.code : "worker_error",
            })
            await handleSlackEventFailure(event, error)
          }
        }),
      )
    } finally {
      ticking = false
    }
  }
  const timer = setInterval(() => {
    void tick().catch(() => appLogger.warn("slack_assistant_queue_unavailable", {}))
  }, 1_000)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
  }
}
