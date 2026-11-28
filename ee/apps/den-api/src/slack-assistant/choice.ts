import { z } from "zod"
import { appLogger } from "../observability/logger.js"
import { defaultWorkbotDirectMessageDeps, workbotSlackCall } from "./direct-message.js"
import { slackRunnerAvailable } from "./headless.js"
import { SlackApiError, type SlackCall, type SlackEvent } from "./protocol.js"
import type { InstallationRow } from "./repository.js"
import { SLACK_CHOICE_PREFIX, SLACK_LIMITS } from "./rich-message.js"
import { slackSafeText } from "./slack-text.js"

export const slackInteractionSchema = z.object({
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  api_app_id: z.string(),
  channel: z.object({ id: z.string() }).optional(),
  container: z.object({ channel_id: z.string().optional(), message_ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
  message: z.object({ ts: z.string(), thread_ts: z.string().optional(), blocks: z.array(z.unknown()).optional() }).optional(),
  actions: z.array(z.object({ action_id: z.string(), block_id: z.string().optional(), value: z.string().optional() })).optional(),
})
export type SlackInteraction = z.infer<typeof slackInteractionSchema>

export type SlackChoiceOutcome = "not_a_choice" | "not_addressed" | "unavailable" | "throttled" | "accepted"

export type SlackChoiceInstallation = Pick<InstallationRow, "connectionId" | "teamId" | "enabled" | "botToken" | "channelIds">

export type SlackChoiceDeps = {
  slack: (installation: SlackChoiceInstallation) => Promise<SlackCall | null>
  enqueue: (installation: SlackChoiceInstallation, eventId: string, event: SlackEvent) => Promise<string | null>
  available: () => boolean
}

const defaultChoiceDeps: SlackChoiceDeps = {
  slack: async (installation) => (installation.botToken ? workbotSlackCall(installation.connectionId, installation.botToken, defaultWorkbotDirectMessageDeps) : null),
  enqueue: async (installation, eventId, event) => (await import("./repository.js")).enqueueSlackEvent(installation, eventId, event),
  available: slackRunnerAvailable,
}

const promptBlock = z.object({ type: z.literal("section"), text: z.object({ type: z.literal("mrkdwn"), text: z.string().min(1).max(SLACK_LIMITS.sectionText) }) })
const choiceBlock = z.object({
  type: z.literal("actions"),
  block_id: z.string(),
  elements: z.array(z.object({ action_id: z.string().optional(), value: z.string().optional(), text: z.object({ text: z.string() }).optional() }).loose()),
})

function offered(blocks: readonly unknown[] | undefined, blockId: string, actionId: string, label: string) {
  for (const block of blocks ?? []) {
    const parsed = choiceBlock.safeParse(block)
    if (parsed.success && parsed.data.block_id === blockId)
      return parsed.data.elements.some((element) => element.action_id === actionId && element.value === label && (element.text === undefined || element.text.text === label))
  }
  return null
}

function shownPrompt(blocks: readonly unknown[] | undefined) {
  for (const block of blocks ?? []) {
    const parsed = promptBlock.safeParse(block)
    if (parsed.success) return parsed.data.text.text
  }
  return null
}

async function tell(slack: SlackCall | null, place: { channel: string; user: string; thread_ts?: string }, text: string) {
  if (!slack) return
  try {
    await slack("chat.postEphemeral", { ...place, text })
  } catch (error) {
    appLogger.warn("slack_choice_notice_failed", { code: error instanceof SlackApiError ? error.code : "request_failed" })
  }
}

export async function answerSlackChoice(
  installation: SlackChoiceInstallation,
  payload: SlackInteraction,
  deps: SlackChoiceDeps = defaultChoiceDeps,
): Promise<{ outcome: SlackChoiceOutcome; settled: Promise<void> }> {
  const done = (outcome: SlackChoiceOutcome, settled: Promise<void> = Promise.resolve()) => ({ outcome, settled })
  const action = (payload.actions ?? []).find((entry) => entry.action_id.startsWith(SLACK_CHOICE_PREFIX) && entry.block_id?.startsWith(SLACK_CHOICE_PREFIX))
  const channel = payload.channel?.id ?? payload.container?.channel_id
  const messageTs = payload.message?.ts ?? payload.container?.message_ts
  const label = action?.value?.trim() ?? ""
  if (!action?.block_id || !channel || !messageTs || !label || label.length > SLACK_LIMITS.buttonText) return done("not_a_choice")
  if (offered(payload.message?.blocks, action.block_id, action.action_id, label) === false) return done("not_a_choice")

  const addressed = action.block_id.slice(SLACK_CHOICE_PREFIX.length)
  const user = payload.user.id
  const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts
  const direct = channel.startsWith("D")
  const slack = await deps.slack(installation)
  const place = { channel, user, ...(threadTs ? { thread_ts: threadTs } : {}) }
  if (user !== addressed) {
    await tell(slack, place, /^[UW][A-Z0-9]{2,}$/.test(addressed) ? `Only <@${addressed}> can answer this.` : "This question is for someone else.")
    return done("not_addressed")
  }
  const allowedChannel = direct || !installation.channelIds?.length || installation.channelIds.includes(channel)
  if (!installation.enabled || !deps.available() || !allowedChannel) {
    await tell(slack, place, "OpenWork isn't answering here right now, so nothing was started. Reply in OpenWork instead.")
    return done("unavailable")
  }
  const event: SlackEvent = {
    type: direct ? "message" : "app_mention",
    ...(direct ? { channel_type: "im" } : {}),
    user,
    channel,
    text: label,
    ts: messageTs,
    thread_ts: threadTs ?? messageTs,
  }
  const eventId = await deps.enqueue(installation, `choice:${channel}:${messageTs}`, event)
  if (!eventId) {
    await tell(slack, place, "Too many requests right now. Try again in a minute.")
    return done("throttled")
  }
  appLogger.info("slack_choice_accepted", { event_id: eventId })
  const prompt = shownPrompt(payload.message?.blocks)
  const chosen = `<@${user}> chose "${slackSafeText(label)}".`
  const settled = slack
    ? slack("chat.update", {
        channel,
        ts: messageTs,
        text: prompt ? `${prompt}\n${chosen}` : chosen,
        blocks: [
          ...(prompt ? [{ type: "section", text: { type: "mrkdwn", text: prompt } }] : []),
          { type: "context", elements: [{ type: "mrkdwn", text: `✅ <@${user}> chose *${slackSafeText(label)}*` }] },
        ],
      }).then(
        () => undefined,
        (error: unknown) => appLogger.warn("slack_choice_update_failed", { event_id: eventId, code: error instanceof SlackApiError ? error.code : "request_failed" }),
      )
    : Promise.resolve()
  return done("accepted", settled)
}
