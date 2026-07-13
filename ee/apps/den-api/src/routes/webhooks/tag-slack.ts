import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  getSlackChannel,
  getSlackUser,
  isRetryableSlackApiError,
  postSlackMessage,
  updateSlackMessage,
} from "../../capability-sources/tag-slack-api.js"
import {
  buildTagPrompt,
  claimAndQueueTagEvent,
  stripSlackBotMention,
  tagCommand,
  tagPromptMessageId,
  tagSlackWebhookBodyLimit,
  verifySlackRequest,
} from "../../capability-sources/tag-slack-webhook.js"
import {
  RetryableTagEventError,
  setTagEventProcessor,
  triggerTagEventDispatcher,
} from "../../capability-sources/tag-dispatcher.js"
import {
  configuredTagSlackOAuth,
  ensureFreshTagConnection,
  isRetryableTagSlackOAuthError,
} from "../../capability-sources/tag-slack-oauth.js"
import {
  cancelTagThread,
  claimTagEvent,
  claimTagControlEvent,
  createTagRun,
  findTagThread,
  getOrCreateTagThread,
  getTagChannel,
  getTagConnectionById,
  getTagOAuthConnectionBySlackTeam,
  getTagThreadById,
  latestTagRunForThread,
  markTagConnectionRevoked,
  noteTagWebhookReceived,
  parseTagConfigSnapshot,
  saveTagWorkerSession,
  setTagEventStatus,
  tagEventIntakeAllowed,
  updateTagRun,
  type TagConnectionRow,
  type TagEventRow,
  type TagThreadRow,
} from "../../capability-sources/tag-store.js"
import {
  abortWorkerSession,
  isRetryableWorkerError,
  loadWorkerAccess,
  runWorkerPrompt,
  WorkerCancelledError,
  type WorkerPromptProgress,
} from "../../capability-sources/worker-session.js"
import { env } from "../../env.js"
import { paramValidator, signedWebhookRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse } from "../../openapi.js"

const paramsSchema = z.object({ connectionId: z.string().trim().min(1).max(64) })
const slackMessageEventSchema = z.object({
  type: z.enum(["app_mention", "message"]),
  channel: z.string().min(1).max(32),
  channel_type: z.string().optional(),
  user: z.string().min(1).max(32).optional(),
  text: z.string().optional(),
  ts: z.string().min(1).max(32),
  thread_ts: z.string().min(1).max(32).optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
})
const slackLifecycleEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("app_uninstalled") }),
  z.object({
    type: z.literal("tokens_revoked"),
    tokens: z.object({
      bot: z.array(z.string().max(32)).optional(),
      oauth: z.array(z.string().max(32)).optional(),
    }),
  }),
])
const slackEventSchema = z.union([slackMessageEventSchema, slackLifecycleEventSchema])
const slackCallbackSchema = z.object({
  type: z.literal("event_callback"),
  api_app_id: z.string().min(1).max(32).optional(),
  event_id: z.string().min(1).max(64),
  team_id: z.string().min(1).max(32),
  enterprise_id: z.string().max(32).nullable().optional(),
  event: slackEventSchema,
})
const queuedTagEventSchema = z.object({
  generation: z.string().min(1),
  callback: slackCallbackSchema,
})
const urlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1).max(512),
})

const webhookResponseSchema = z.object({ ok: z.literal(true), accepted: z.boolean(), reason: z.string().optional() })
const webhookUnauthorizedSchema = z.object({ ok: z.literal(false), error: z.string() })
const challengeResponseSchema = z.object({ challenge: z.string() })

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class TagConnectionGenerationChanged extends Error {
  constructor() {
    super("OpenWork Tag was disconnected or reconfigured.")
    this.name = "TagConnectionGenerationChanged"
  }
}

async function currentTagConnection(input: {
  connectionId: TagConnectionRow["id"]
  dispatchToken: string
  generation: string
}): Promise<TagConnectionRow | null> {
  const connection = await getTagConnectionById(input.connectionId)
  if (
    connection?.status !== "active"
    || connection.signingSecret !== input.generation
    || connection.dispatchToken !== input.dispatchToken
  ) return null
  const current = await ensureFreshTagConnection(connection)
  if (
    current.status !== "active"
    || current.signingSecret !== input.generation
    || current.dispatchToken !== input.dispatchToken
  ) return null
  return current
}

async function postForCurrentConnection(input: {
  channelId: string
  connectionId: TagConnectionRow["id"]
  dispatchToken: string
  generation: string
  text: string
  threadTs: string
}) {
  const connection = await currentTagConnection(input)
  if (!connection) throw new TagConnectionGenerationChanged()
  try {
    return await postSlackMessage({
      botToken: connection.botToken,
      channelId: input.channelId,
      text: input.text,
      threadTs: input.threadTs,
    })
  } catch (error) {
    if (isRetryableSlackApiError(error)) throw new RetryableTagEventError(error)
    throw error
  }
}

async function updateForCurrentConnection(input: {
  channelId: string
  connectionId: TagConnectionRow["id"]
  dispatchToken: string
  generation: string
  text: string
  ts: string
}) {
  const connection = await currentTagConnection(input)
  if (!connection) throw new TagConnectionGenerationChanged()
  try {
    await updateSlackMessage({
      botToken: connection.botToken,
      channelId: input.channelId,
      text: input.text,
      ts: input.ts,
    })
  } catch (error) {
    if (isRetryableSlackApiError(error)) throw new RetryableTagEventError(error)
    throw error
  }
}

async function postControlForCurrentConnection(input: {
  channelId: string
  connectionId: TagConnectionRow["id"]
  generation: string
  text: string
  threadTs: string
}) {
  const connection = await getTagConnectionById(input.connectionId)
  if (connection?.status !== "active" || connection.signingSecret !== input.generation) {
    throw new TagConnectionGenerationChanged()
  }
  const current = await ensureFreshTagConnection(connection)
  return postSlackMessage({
    botToken: current.botToken,
    channelId: input.channelId,
    text: input.text,
    threadTs: input.threadTs,
  })
}

function progressText(serviceName: string, progress: WorkerPromptProgress): string {
  const active = progress.todos.filter((todo) => todo.status === "in_progress")
  const completed = progress.todos.filter((todo) => todo.status === "completed")
  if (active[0]) {
    const count = progress.todos.length > 0 ? ` (${completed.length}/${progress.todos.length})` : ""
    return `:gear: *${serviceName} is working${count}*\n${active[0].content}`
  }
  if (progress.status === "retry") return `:hourglass_flowing_sand: *${serviceName} is waiting to retry…*`
  return `:gear: *${serviceName} is working…*`
}

function runStatusText(serviceName: string, run: Awaited<ReturnType<typeof latestTagRunForThread>>) {
  if (!run) return `*${serviceName} status:* no accepted request exists in this thread yet.`
  const labels = {
    accepted: "queued",
    running: "working",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  } as const
  const detail = run.error ? `\n${run.error}` : ""
  return `*${serviceName} status:* ${labels[run.status]}.${detail}`
}

function commandHelp(serviceName: string) {
  return [
    `*${serviceName} commands*`,
    "• Mention me with a request to start a shared agent thread.",
    "• Reply in this thread to continue the same OpenCode session—no mention needed.",
    "• `status` shows the durable run state.",
    "• `cancel` stops the linked OpenCode session.",
    "• `what can you access?` explains the active execution boundary.",
  ].join("\n")
}

async function handleCommand(input: {
  command: NonNullable<ReturnType<typeof tagCommand>>
  connection: TagConnectionRow
  post: (text: string) => Promise<unknown>
  thread: TagThreadRow
}) {
  const snapshot = parseTagConfigSnapshot(input.thread.configSnapshot)
  const serviceName = snapshot?.serviceName ?? input.connection.serviceName
  let text = ""
  if (input.command === "help") text = commandHelp(serviceName)
  if (input.command === "access") {
    text = [
      `*${serviceName} access boundary*`,
      `• Slack: this approved channel and thread only; DMs are disabled.`,
      `• Execution: the OpenWork worker selected by your workspace admin.`,
      `• Identity: channel service identity, shared by authorized thread members.`,
      `• Tools and files: only what that worker session is configured to access.`,
      `• Secrets: Slack credentials remain encrypted in Den and are never sent to the worker or model.`,
      `• Policy snapshot: \`${input.thread.configSnapshotHash.slice(0, 12)}\`.`,
    ].join("\n")
  }
  if (input.command === "status") {
    text = runStatusText(serviceName, await latestTagRunForThread(input.thread.id))
  }
  if (input.command === "cancel") {
    const run = await latestTagRunForThread(input.thread.id)
    if (run && ["accepted", "running"].includes(run.status)) {
      await updateTagRun({ id: run.id, status: "cancelled" })
    }
    await cancelTagThread(input.thread.id)
    let abortWarning = ""
    if (input.thread.workerSessionId && snapshot) {
      const access = await loadWorkerAccess({
        organizationId: input.connection.organizationId,
        workerId: snapshot.workerId,
      })
      if (access) {
        try {
          const aborted = await abortWorkerSession({
            access,
            preferredWorkspaceId: input.thread.workerWorkspaceId ?? undefined,
            sessionId: input.thread.workerSessionId,
          })
          if (!aborted) abortWarning = " The durable run is cancelled in Den; OpenCode reported no active run to abort."
        } catch {
          abortWarning = " The durable run is cancelled in Den; the worker endpoint did not acknowledge the abort."
        }
      } else {
        abortWarning = " The durable run is cancelled in Den; the worker is currently offline."
      }
    }
    text = `:stop_sign: *${serviceName} stopped this thread's OpenCode session.*${abortWarning} Mention me with a new request in a new Slack thread to start again.`
  }
  await input.post(text)
}

async function denyTagRequest(input: {
  connection: TagConnectionRow
  dispatchToken: string
  generation: string
  message: string
  event: z.infer<typeof slackEventSchema>
}) {
  if (!("channel" in input.event)) return
  if (input.event.type !== "app_mention") return
  await postForCurrentConnection({
    channelId: input.event.channel,
    connectionId: input.connection.id,
    dispatchToken: input.dispatchToken,
    generation: input.generation,
    text: `:no_entry: ${input.message}`,
    threadTs: input.event.thread_ts ?? input.event.ts,
  })
}

async function processTagEvent(input: {
  callback: z.infer<typeof slackCallbackSchema>
  connection: TagConnectionRow
  dispatchToken: string
  eventRow: TagEventRow
  generation: string
}) {
  const updateStatus = (status: Parameters<typeof setTagEventStatus>[0]["status"], error: string | null = null) =>
    setTagEventStatus({
      connectionId: input.connection.id,
      error,
      id: input.eventRow.id,
      processingToken: input.dispatchToken,
      status,
    })
  const current = await currentTagConnection({
    connectionId: input.connection.id,
    dispatchToken: input.dispatchToken,
    generation: input.generation,
  })
  if (!current) {
    await updateStatus("ignored")
    return
  }
  input.connection = current
  const event = input.callback.event
  if (!("channel" in event)) {
    await updateStatus("ignored")
    return
  }
  if (
    input.callback.team_id !== current.slackTeamId
    || event.channel_type === "im"
    || event.bot_id
    || event.subtype
    || !event.user
    || !event.text?.trim()
  ) {
    await updateStatus("ignored")
    return
  }
  const mentioned = event.type === "app_mention" || event.text.includes(`<@${current.botUserId}>`)
  const threadTs = event.thread_ts ?? event.ts
  let thread = await findTagThread({
    channelId: event.channel,
    connectionId: current.id,
    threadTs,
  })
  if (!mentioned && (!thread || thread.status !== "active")) {
    await updateStatus("ignored")
    return
  }
  const configuredChannel = await getTagChannel(current.id, event.channel)
  if (!configuredChannel) {
    await denyTagRequest({
      connection: current,
      dispatchToken: input.dispatchToken,
      event,
      generation: input.generation,
      message: "OpenWork Tag is not enabled in this channel.",
    })
    await updateStatus("ignored")
    return
  }

  const [slackChannel, slackUser] = await Promise.all([
    getSlackChannel({ botToken: current.botToken, channelId: event.channel }),
    getSlackUser({ botToken: current.botToken, userId: event.user }),
  ])
  const allowedUsers = (() => {
    try {
      const parsed: unknown = JSON.parse(current.allowedUserIds)
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []
    } catch {
      return []
    }
  })()
  const deniedReason = slackUser.deleted
    ? "This Slack account is inactive."
    : slackUser.guest && !current.allowGuests
      ? "Guest accounts are not allowed by this workspace's Tag policy."
      : slackChannel.isShared && !current.allowSharedChannels
        ? "Slack Connect channels are disabled by this workspace's Tag policy."
        : allowedUsers.length > 0 && !allowedUsers.includes(slackUser.id)
          ? "Your Slack account is not in this workspace's Tag allowlist."
          : null
  if (deniedReason) {
    await denyTagRequest({
      connection: current,
      dispatchToken: input.dispatchToken,
      event,
      generation: input.generation,
      message: deniedReason,
    })
    await updateStatus("ignored")
    return
  }

  const text = stripSlackBotMention(event.text, current.botUserId)
  if (text.length > 12_000) {
    await denyTagRequest({
      connection: current,
      dispatchToken: input.dispatchToken,
      event,
      generation: input.generation,
      message: "Keep requests under 12,000 characters.",
    })
    await updateStatus("ignored")
    return
  }
  if (!thread) {
    thread = await getOrCreateTagThread({
      connectionId: current.id,
      enterpriseId: input.callback.enterprise_id ?? null,
      slackChannelId: event.channel,
      slackTeamId: input.callback.team_id,
      slackThreadTs: threadTs,
      snapshot: {
        allowGuests: current.allowGuests,
        allowSharedChannels: current.allowSharedChannels,
        channelId: event.channel,
        channelName: configuredChannel.slackChannelName,
        instructions: configuredChannel.instructions ?? current.defaultInstructions,
        serviceName: current.serviceName,
        version: 1,
        workerId: current.workerId,
      },
      startedBySlackUserId: event.user,
    })
  }
  if (thread.status !== "active") {
    await denyTagRequest({
      connection: current,
      dispatchToken: input.dispatchToken,
      event,
      generation: input.generation,
      message: "This Tag thread was cancelled. Start a new Slack thread and mention me there.",
    })
    await updateStatus("ignored")
    return
  }
  const command = tagCommand(text || "help")
  if (command) {
    await handleCommand({
      command,
      connection: current,
      post: (commandText) => postForCurrentConnection({
        channelId: thread.slackChannelId,
        connectionId: current.id,
        dispatchToken: input.dispatchToken,
        generation: input.generation,
        text: commandText,
        threadTs: thread.slackThreadTs,
      }),
      thread,
    })
    await updateStatus("completed")
    return
  }

  const snapshot = parseTagConfigSnapshot(thread.configSnapshot)
  if (!snapshot) {
    await updateStatus("failed", "Stored OpenWork Tag config snapshot is invalid.")
    return
  }
  const run = await createTagRun({
    eventId: input.eventRow.id,
    prompt: text,
    slackUserId: event.user,
    threadId: thread.id,
  })
  let statusTs = run.slackStatusMessageTs
  try {
    if (!statusTs) {
      const message = await postForCurrentConnection({
        channelId: event.channel,
        connectionId: current.id,
        dispatchToken: input.dispatchToken,
        generation: input.generation,
        text: `:gear: *${snapshot.serviceName} accepted this request.*\nStarting a durable OpenCode run…`,
        threadTs,
      })
      statusTs = message.ts
    }
    await updateTagRun({ id: run.id, slackStatusMessageTs: statusTs, status: "running" })
    const access = await loadWorkerAccess({
      organizationId: current.organizationId,
      workerId: snapshot.workerId,
    })
    if (!access) throw new Error("The selected OpenWork worker is unavailable.")
    let lastProgressUpdate = 0
    let lastProgressText = ""
    const result = await runWorkerPrompt({
      access,
      messageId: tagPromptMessageId(input.eventRow.id),
      onProgress: async (progress) => {
        const nextText = progressText(snapshot.serviceName, progress)
        const now = Date.now()
        if (nextText === lastProgressText || now - lastProgressUpdate < 3_000 || !statusTs) return
        lastProgressText = nextText
        lastProgressUpdate = now
        await updateForCurrentConnection({
          channelId: event.channel,
          connectionId: current.id,
          dispatchToken: input.dispatchToken,
          generation: input.generation,
          text: nextText,
          ts: statusTs,
        })
      },
      onSessionReady: async (session) => {
        const saved = await saveTagWorkerSession({
          connectionId: current.id,
          dispatchToken: input.dispatchToken,
          generation: input.generation,
          sessionId: session.sessionId,
          threadId: thread.id,
          workspaceId: session.workspaceId,
        })
        if (!saved) throw new TagConnectionGenerationChanged()
      },
      preferredWorkspaceId: thread.workerWorkspaceId ?? undefined,
      sessionId: thread.workerSessionId ?? undefined,
      shouldStop: async () => (await getTagThreadById(thread.id))?.status === "cancelled",
      text: buildTagPrompt({
        channelName: snapshot.channelName,
        instructions: snapshot.instructions,
        serviceName: snapshot.serviceName,
        slackUserId: event.user,
        text,
      }),
      title: `Slack ${snapshot.channelName ? `#${snapshot.channelName}` : event.channel} thread`,
    })
    await updateForCurrentConnection({
      channelId: event.channel,
      connectionId: current.id,
      dispatchToken: input.dispatchToken,
      generation: input.generation,
      text: `:white_check_mark: *${snapshot.serviceName} completed*\n\n${result.text}\n\n_Run \`${run.id}\` · policy \`${thread.configSnapshotHash.slice(0, 12)}\`_`,
      ts: statusTs,
    })
    await updateTagRun({ id: run.id, response: result.text, slackStatusMessageTs: statusTs, status: "completed" })
    await updateStatus("completed")
  } catch (error) {
    if (error instanceof TagConnectionGenerationChanged) {
      await updateStatus("ignored")
      return
    }
    if (error instanceof WorkerCancelledError) {
      if (statusTs) {
        try {
          await updateForCurrentConnection({
            channelId: event.channel,
            connectionId: current.id,
            dispatchToken: input.dispatchToken,
            generation: input.generation,
            text: `:stop_sign: *${snapshot.serviceName} stopped this OpenCode run.*\n\n_Run \`${run.id}\`_`,
            ts: statusTs,
          })
        } catch {
          // The cancelled Den run remains authoritative if Slack is unavailable.
        }
      }
      await updateTagRun({ id: run.id, slackStatusMessageTs: statusTs, status: "cancelled" })
      await updateStatus("completed")
      return
    }
    const retryable = error instanceof RetryableTagEventError
      || isRetryableWorkerError(error)
      || isRetryableTagSlackOAuthError(error)
    if (retryable && input.eventRow.attempts < 3) {
      if (statusTs) {
        try {
          await updateForCurrentConnection({
            channelId: event.channel,
            connectionId: current.id,
            dispatchToken: input.dispatchToken,
            generation: input.generation,
            text: `:hourglass_flowing_sand: *${snapshot.serviceName} temporarily lost its connection.*\nThe durable run will retry automatically.`,
            ts: statusTs,
          })
        } catch {
          // The durable event retry remains the source of truth.
        }
      }
      throw new RetryableTagEventError(error)
    }
    const terminalMessage = `:warning: *${snapshot.serviceName} could not complete this request.*\n${errorMessage(error)}\n\n_Run \`${run.id}\`_`
    if (statusTs) {
      try {
        await updateForCurrentConnection({
          channelId: event.channel,
          connectionId: current.id,
          dispatchToken: input.dispatchToken,
          generation: input.generation,
          text: terminalMessage,
          ts: statusTs,
        })
      } catch {
        // Preserve the original terminal error in Den even if Slack is down.
      }
    }
    await updateTagRun({ id: run.id, error: errorMessage(error), slackStatusMessageTs: statusTs, status: "failed" })
    await updateStatus("failed", errorMessage(error))
  }
}

async function processTagLifecycleEvent(input: {
  callback: z.infer<typeof slackCallbackSchema>
  connection: TagConnectionRow
}) {
  const event = input.callback.event
  if ("channel" in event) return false
  const revoked = event.type === "app_uninstalled"
    || (event.tokens.bot ?? []).includes(input.connection.botUserId)
  if (!revoked) return false
  const reason = event.type === "app_uninstalled"
    ? "Slack reported that OpenWork Tag was uninstalled. Reinstall it from Den to resume."
    : "Slack reported that OpenWork Tag's bot token was revoked. Reinstall it from Den to resume."
  const cancelledThreads = await markTagConnectionRevoked({ connectionId: input.connection.id, reason })
  await Promise.all(cancelledThreads.map(async (thread) => {
    const snapshot = parseTagConfigSnapshot(thread.configSnapshot)
    if (!snapshot || !thread.workerSessionId) return
    const access = await loadWorkerAccess({
      organizationId: input.connection.organizationId,
      workerId: snapshot.workerId,
    })
    if (!access) return
    try {
      await abortWorkerSession({
        access,
        preferredWorkspaceId: thread.workerWorkspaceId ?? undefined,
        sessionId: thread.workerSessionId,
      })
    } catch (error) {
      console.warn("tag_slack_revocation_abort_failed", {
        connectionId: input.connection.id,
        threadId: thread.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    }
  }))
  return true
}

async function processQueuedTagEvent(row: TagEventRow) {
  if (!row.processingToken) return
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    await setTagEventStatus({
      connectionId: row.connectionId,
      error: "Stored Slack event payload is invalid JSON.",
      id: row.id,
      processingToken: row.processingToken,
      status: "failed",
    })
    return
  }
  const parsed = queuedTagEventSchema.safeParse(payload)
  if (!parsed.success) {
    await setTagEventStatus({
      connectionId: row.connectionId,
      error: "Stored Slack event payload is invalid.",
      id: row.id,
      processingToken: row.processingToken,
      status: "failed",
    })
    return
  }
  const connection = await currentTagConnection({
    connectionId: row.connectionId,
    dispatchToken: row.processingToken,
    generation: parsed.data.generation,
  })
  if (!connection) {
    await setTagEventStatus({
      connectionId: row.connectionId,
      id: row.id,
      processingToken: row.processingToken,
      status: "ignored",
    })
    return
  }
  if (!("channel" in parsed.data.callback.event)) {
    const revoked = await processTagLifecycleEvent({ callback: parsed.data.callback, connection })
    await setTagEventStatus({
      connectionId: row.connectionId,
      id: row.id,
      processingToken: row.processingToken,
      status: revoked ? "completed" : "ignored",
    })
    return
  }
  await processTagEvent({
    callback: parsed.data.callback,
    connection,
    dispatchToken: row.processingToken,
    eventRow: row,
    generation: parsed.data.generation,
  })
}

/**
 * Status and cancellation must not wait behind the long-running request they
 * control. The event is still durably claimed and fully re-authorized here;
 * only the per-connection execution lease is bypassed.
 */
async function processImmediateTagControl(input: {
  callback: z.infer<typeof slackCallbackSchema>
  eventRow: TagEventRow
  generation: string
}) {
  const processingToken = input.eventRow.processingToken
  if (!processingToken) return
  const finish = (status: Parameters<typeof setTagEventStatus>[0]["status"], error: string | null = null) =>
    setTagEventStatus({
      connectionId: input.eventRow.connectionId,
      error,
      id: input.eventRow.id,
      processingToken,
      status,
    })
  try {
    const connection = await getTagConnectionById(input.eventRow.connectionId)
    const event = input.callback.event
    if (
      connection?.status !== "active"
      || connection.signingSecret !== input.generation
      || !("channel" in event)
      || input.callback.team_id !== connection.slackTeamId
      || !event.thread_ts
      || event.channel_type === "im"
      || event.bot_id
      || event.subtype
      || !event.user
      || !event.text?.trim()
    ) {
      await finish("ignored")
      return
    }
    const current = await ensureFreshTagConnection(connection)
    const command = tagCommand(stripSlackBotMention(event.text, connection.botUserId))
    if (!command) {
      await finish("ignored")
      return
    }
    const [thread, configuredChannel, slackChannel, slackUser] = await Promise.all([
      findTagThread({
        channelId: event.channel,
        connectionId: connection.id,
        threadTs: event.thread_ts,
      }),
      getTagChannel(current.id, event.channel),
      getSlackChannel({ botToken: current.botToken, channelId: event.channel }),
      getSlackUser({ botToken: current.botToken, userId: event.user }),
    ])
    let allowedUsers: string[] = []
    try {
      const parsed: unknown = JSON.parse(connection.allowedUserIds)
      if (Array.isArray(parsed)) allowedUsers = parsed.filter((value): value is string => typeof value === "string")
    } catch {
      allowedUsers = []
    }
    const authorized = Boolean(
      thread?.status === "active"
      && configuredChannel
      && !slackUser.deleted
      && (current.allowGuests || !slackUser.guest)
      && (current.allowSharedChannels || !slackChannel.isShared)
      && (allowedUsers.length === 0 || allowedUsers.includes(slackUser.id)),
    )
    if (!thread || !authorized) {
      await finish("ignored")
      return
    }
    await handleCommand({
      command,
      connection: current,
      post: (text) => postControlForCurrentConnection({
        channelId: thread.slackChannelId,
        connectionId: current.id,
        generation: input.generation,
        text,
        threadTs: thread.slackThreadTs,
      }),
      thread,
    })
    await finish("completed")
  } catch (error) {
    await finish("failed", errorMessage(error))
  }
}

async function processImmediateTagLifecycle(input: {
  callback: z.infer<typeof slackCallbackSchema>
  eventRow: TagEventRow
  generation: string
}) {
  const processingToken = input.eventRow.processingToken
  if (!processingToken) return
  const finish = (status: Parameters<typeof setTagEventStatus>[0]["status"], error: string | null = null) =>
    setTagEventStatus({
      connectionId: input.eventRow.connectionId,
      error,
      id: input.eventRow.id,
      processingToken,
      status,
    })
  try {
    const connection = await getTagConnectionById(input.eventRow.connectionId)
    if (
      connection?.status !== "active"
      || connection.signingSecret !== input.generation
      || input.callback.team_id !== connection.slackTeamId
      || "channel" in input.callback.event
    ) {
      await finish("ignored")
      return
    }
    const revoked = await processTagLifecycleEvent({ callback: input.callback, connection })
    await finish(revoked ? "completed" : "ignored")
  } catch (error) {
    await finish("failed", errorMessage(error))
  }
}

setTagEventProcessor(processQueuedTagEvent)

async function acceptVerifiedTagCallback(
  connection: TagConnectionRow,
  callback: z.infer<typeof slackCallbackSchema>,
) {
  if (callback.team_id !== connection.slackTeamId || connection.status !== "active") {
    return { ok: true as const, accepted: false, reason: "connection inactive or workspace mismatch" }
  }
  if (!await tagEventIntakeAllowed(connection.id)) {
    return { ok: true as const, accepted: false, reason: "rate limit or backlog reached" }
  }
  const messageEvent = "channel" in callback.event ? callback.event : null
  const lifecycleEvent = !messageEvent
  const controlCommand = messageEvent?.thread_ts
    ? tagCommand(stripSlackBotMention(messageEvent.text ?? "", connection.botUserId))
    : null
  let immediateControlRow: TagEventRow | null = null
  const response = await claimAndQueueTagEvent({
    claim: async () => {
      const event = await claimTagEvent({
        connectionId: connection.id,
        payload: JSON.stringify({ callback, generation: connection.signingSecret }),
        slackEventId: callback.event_id,
      })
      if (event.claimed && (controlCommand || lifecycleEvent)) {
        immediateControlRow = await claimTagControlEvent({ connectionId: connection.id, id: event.id })
      }
      return { claimed: event.claimed, value: event.id }
    },
    queue: () => {
      if (immediateControlRow) {
        const immediate = lifecycleEvent ? processImmediateTagLifecycle : processImmediateTagControl
        void immediate({
          callback,
          eventRow: immediateControlRow,
          generation: connection.signingSecret,
        }).catch((error) => console.error("[tag] immediate event failed", error))
      } else {
        triggerTagEventDispatcher()
      }
    },
  })
  if (response.accepted) await noteTagWebhookReceived(connection.id)
  return response
}

export function registerTagSlackWebhookRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    "/v1/webhooks/tag/slack/oauth",
    describeRoute({
      tags: ["Webhooks"],
      summary: "OpenWork-managed Slack OAuth Events API ingress",
      description: "Uses the deployment Slack app signing secret, resolves the encrypted installation by Slack team, and durably accepts the event.",
      responses: {
        200: jsonResponse("Slack event accepted, deduped, or URL challenge answered.", webhookResponseSchema.or(challengeResponseSchema)),
        400: jsonResponse("Invalid Slack event.", invalidRequestSchema),
        401: jsonResponse("Invalid or stale Slack signature.", webhookUnauthorizedSchema),
      },
    }),
    tagSlackWebhookBodyLimit,
    signedWebhookRoute,
    async (c) => {
      const oauth = configuredTagSlackOAuth()
      if (!env.tagSlackEnabled || !oauth) return c.json({ ok: true, accepted: false, reason: "tag oauth disabled" })
      const body = await c.req.text()
      const verification = verifySlackRequest({
        body,
        signature: c.req.header("x-slack-signature")?.trim() ?? "",
        signingSecret: oauth.signingSecret,
        timestamp: c.req.header("x-slack-request-timestamp")?.trim() ?? "",
      })
      if (!verification.ok) return c.json({ ok: false, error: verification.reason }, 401)
      let payload: unknown
      try {
        payload = JSON.parse(body)
      } catch {
        return c.json({ error: "invalid_request", message: "Slack payload must be JSON." }, 400)
      }
      const challenge = urlVerificationSchema.safeParse(payload)
      if (challenge.success) return c.json({ challenge: challenge.data.challenge })
      const parsed = slackCallbackSchema.safeParse(payload)
      if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error }, 400)
      const connection = await getTagOAuthConnectionBySlackTeam(parsed.data.team_id)
      if (!connection || (parsed.data.api_app_id && connection.slackAppId !== parsed.data.api_app_id)) {
        return c.json({ ok: true, accepted: false, reason: "installation not found" })
      }
      return c.json(await acceptVerifiedTagCallback(connection, parsed.data))
    },
  )

  app.post(
    "/v1/webhooks/tag/slack/:connectionId",
    describeRoute({
      tags: ["Webhooks"],
      summary: "OpenWork Tag Slack Events API ingress",
      description: "Verifies Slack HMAC and replay window, handles URL verification, durably dedupes event_id, and acknowledges before worker execution.",
      responses: {
        200: jsonResponse("Slack event accepted, deduped, or URL challenge answered.", webhookResponseSchema.or(challengeResponseSchema)),
        400: jsonResponse("Invalid Slack event.", invalidRequestSchema),
        401: jsonResponse("Invalid or stale Slack signature.", webhookUnauthorizedSchema),
      },
    }),
    tagSlackWebhookBodyLimit,
    signedWebhookRoute,
    paramValidator(paramsSchema),
    async (c) => {
      if (!env.tagSlackEnabled) return c.json({ ok: true, accepted: false, reason: "tag disabled" })
      let connectionId
      try {
        connectionId = normalizeDenTypeId("tagConnection", c.req.valid("param").connectionId)
      } catch {
        return c.json({ ok: true, accepted: false, reason: "connection not found" }, 404)
      }
      const connection = await getTagConnectionById(connectionId)
      if (!connection) return c.json({ ok: true, accepted: false, reason: "connection not found" }, 404)

      const body = await c.req.text()
      const verification = verifySlackRequest({
        body,
        signature: c.req.header("x-slack-signature")?.trim() ?? "",
        signingSecret: connection.signingSecret,
        timestamp: c.req.header("x-slack-request-timestamp")?.trim() ?? "",
      })
      if (!verification.ok) return c.json({ ok: false, error: verification.reason }, 401)

      let payload: unknown
      try {
        payload = JSON.parse(body)
      } catch {
        return c.json({ error: "invalid_request", message: "Slack payload must be JSON." }, 400)
      }
      const challenge = urlVerificationSchema.safeParse(payload)
      if (challenge.success) return c.json({ challenge: challenge.data.challenge })
      const parsed = slackCallbackSchema.safeParse(payload)
      if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error }, 400)
      return c.json(await acceptVerifiedTagCallback(connection, parsed.data))
    },
  )
}
