import {
  checkpointSchema,
  advanceSlackRun,
  stopSlackStream,
  RemoteSessionUnavailableError,
  QUEUED_LINE,
  type Checkpoint,
} from "./run.js"
import { z } from "zod"
import { appLogger } from "../observability/logger.js"
import { openworkYourConnectionsUrl } from "../mcp/connection-navigation.js"
import { buildSlackPrompt, isInvocation, SlackApiError, slackClient, slackEventSchema, type SlackCall } from "./protocol.js"
import { createSlackRunner, slackRunnerAvailable, type SlackRunner } from "./headless.js"
import {
  slackAssistantEnabledForInstallation,
  admitSlackRun,
  latestSlackContext,
  removeSlackIdentities,
  persistSlackCheckpoint,
  cancelSlackThread,
  checkpointEvent,
  claimSlackEvent,
  getInstallation,
  lockSlackThread,
  releaseSlackThread,
  resolveSlackActor,
  linkConnectedSlackMembers,
  revokeSlackInstallation,
  saveSlackSession,
  clearSlackSession,
  type EventRow,
  type SlackActor,
} from "./repository.js"
import { pruneSlackEvents, renewSlackLease, SlackLeaseLostError } from "./repository.js"

type WorkerDeps = {
  slack: typeof slackClient
  runner: (actor: SlackActor) => SlackRunner
}

const defaultWorkerDeps: WorkerDeps = {
  slack: slackClient,
  runner: (actor) => createSlackRunner(actor),
}

/** Every runner call first renews the event's lease, so a slow runner never lets another worker take the event. */
function leasedRunner(runner: SlackRunner, event: EventRow): SlackRunner {
  return {
    create: async (input) => {
      await renewSlackLease(event)
      return runner.create(input)
    },
    send: async (input) => {
      await renewSlackLease(event)
      return runner.send(input)
    },
    read: async (input) => {
      await renewSlackLease(event)
      return runner.read(input)
    },
    stop: async (input) => {
      await renewSlackLease(event)
      return runner.stop(input)
    },
  }
}

/** Slack replies need the deployment's headless runner. Without one, say so to the person who asked, once. */
async function answerWithoutRunner(event: EventRow, slack: SlackCall, invocation: boolean, cp: Checkpoint) {
  if (cp.channel) {
    // The runner went away mid-run: close the reply instead of leaving Slack's working status on.
    try {
      await stopSlackStream(slack, { ...cp, finalStatus: "suspended" }, { chunks: [{ type: "markdown_text", text: "\n\nThis task stopped." }] })
    } catch {
      /* Slack may already have closed it. */
    }
  } else if (invocation && event.status === "pending") {
    try {
      await slack("chat.postEphemeral", {
        channel: event.channelId,
        user: event.slackUserId,
        thread_ts: event.threadTs,
        text: "OpenWork can't answer in Slack on this deployment yet: it needs the OpenWork cloud runner. Ask your OpenWork admin to set it up.",
      })
    } catch {
      /* The bot may not be in the channel; nothing else to tell. */
    }
  }
  await releaseSlackThread(event)
  return checkpointEvent(event, { status: "done" })
}

export async function processSlackEvent(event: EventRow, suppliedDeps: WorkerDeps = defaultWorkerDeps) {
  await renewSlackLease(event)
  const deps: WorkerDeps = {
    slack: (token) => async (method, body) => {
      await renewSlackLease(event)
      return suppliedDeps.slack(token)(method, body)
    },
    runner: (actor) => leasedRunner(suppliedDeps.runner(actor), event),
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
  if (payload.type === "agent_session_title_changed") return checkpointEvent(event, { status: "done" })
  const cp = checkpointSchema.parse(event.checkpoint ? JSON.parse(event.checkpoint) : {})
  if (!slackRunnerAvailable()) return answerWithoutRunner(event, slack, isInvocation(payload), cp)
  let actor = await resolveSlackActor(installation, event.slackUserId)
  // Members who connected Slack before the assistant existed are linked from their token, not asked to reconnect.
  if (!actor && event.status !== "running" && installation.enabled && (await linkConnectedSlackMembers(installation, deps.slack)) > 0)
    actor = await resolveSlackActor(installation, event.slackUserId)
  if (!actor) {
    if (
      event.status === "running" ||
      !installation.enabled ||
      !(await slackAssistantEnabledForInstallation(installation))
    ) {
      if (cp.channel) {
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
      text: "I work as you in OpenWork. Connect once to get started.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "I work as you, with the apps and skills you have in OpenWork. Connect your Slack account once to continue. Your workspace must give you access to this connection.",
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
  const { thread, busy } = await lockSlackThread(event, actor)
  if (!thread) {
    // An earlier task of this member holds the thread; this message runs right after it. Say so once.
    if (busy && !cp.queuedNoticeShown) {
      const notice = { channel: event.channelId, thread_ts: event.threadTs, text: QUEUED_LINE }
      const privateReply = installation.shadowMode || /(^|\s)--private(?=\s|$)/.test(payload.text ?? "")
      if (privateReply && payload.channel_type !== "im")
        await slack("chat.postEphemeral", { ...notice, user: event.slackUserId })
      else await slack("chat.postMessage", notice)
      return checkpointEvent(event, { checkpoint: JSON.stringify({ ...cp, queuedNoticeShown: true }) }, 2_000)
    }
    return checkpointEvent(event, {}, 2_000)
  }
  const runner = deps.runner(actor)
  if (event.cancelled) {
    if (cp.sessionId && cp.phase !== "create") await runner.stop({ sessionId: cp.sessionId, messageId: `msg_${event.id}` })
    if (cp.channel)
      await stopSlackStream(slack, { ...cp, finalStatus: "suspended" }, { chunks: [{ type: "markdown_text", text: "\n\nStopped." }] })
    await releaseSlackThread(event)
    return checkpointEvent(event, { status: "done" })
  }
  if (cp.phase === "create" && !cp.prompt) {
    if (!(await admitSlackRun(event, installation))) {
      await slack("chat.postEphemeral", {
        channel: event.channelId,
        user: event.slackUserId,
        text: "OpenWork Slack has paused new requests because of a usage limit or repeated service failures. Please try again later.",
      })
      await releaseSlackThread(event)
      return checkpointEvent(event, { status: "done" })
    }
    // Validate the live user credential again before accepting a new turn.
    const identity = await deps.slack(actor.userToken)("auth.test", {})
    if (identity.user_id !== event.slackUserId || identity.team_id !== event.teamId || identity.bot_id)
      throw new Error("slack_actor_mismatch")
    cp.startedAt ??= Date.now()
    // Quiet by default: Slack's working status, then the answer. Admins can turn on live steps and notes.
    cp.live = installation.progressUpdates
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
    // Slack's thinking status shows right away; the reply stream opens with the first step or answer text.
    await slack("agents.sessions.setStatus", {
      channel_id: cp.channel,
      thread_ts: cp.threadTs,
      status: "processing",
      initiator_user_id: event.slackUserId,
      title: "OpenWork task",
    })
    await persistSlackCheckpoint(event, cp)
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
    await checkpointEvent(event, { status: "running", checkpoint: JSON.stringify(cp) })
    return
  }
  cp.sessionId ??= thread.sessionId ?? undefined
  const result = await advanceSlackRun({
    checkpoint: cp,
    slack,
    runner,
    messageId: `msg_${event.id}`,
    saveSession: async (sessionId) => {
      await renewSlackLease(event)
      await saveSlackSession(thread.id, sessionId)
    },
    clearSession: async () => {
      await renewSlackLease(event)
      await clearSlackSession(thread.id)
    },
    persist: (checkpoint) => persistSlackCheckpoint(event, checkpoint),
    title: `${event.channelId} · ${(payload.text ?? "Task").slice(0, 85)}`,
    model: installation.model ?? undefined,
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
  if (!stopped)
    appLogger.warn("slack_assistant_failed", {
      event_id: event.id,
      attempts: event.attempts,
      code:
        error instanceof SlackApiError
          ? error.code
          : error instanceof RemoteSessionUnavailableError
            ? "remote_session_unavailable"
            : "worker_error",
      elapsed_ms: Date.now() - event.createdAt.getTime(),
    })
  await renewSlackLease(event)
  const installation = await getInstallation(event.connectionId)
  const cp = checkpointSchema.parse(event.checkpoint ? JSON.parse(event.checkpoint) : {})
  if (installation) {
    const actor = await resolveSlackActor(installation, event.slackUserId)
    if (actor && cp.sessionId) {
      try {
        await deps.runner(actor).stop({ sessionId: cp.sessionId, messageId: `msg_${event.id}` })
      } catch {
        /* Runtime may be unreachable. */
      }
    }
    if (installation.botToken && cp.channel) {
      try {
        await stopSlackStream(
          deps.slack(installation.botToken),
          { ...cp, finalStatus: "suspended" },
          {
            chunks: [
              {
                type: "markdown_text",
                text: "\n\nThis task stopped. Try again in a moment.",
              },
            ],
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
