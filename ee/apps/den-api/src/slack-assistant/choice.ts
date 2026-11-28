import { z } from "zod"
import { appLogger } from "../observability/logger.js"
import { defaultWorkbotDirectMessageDeps, workbotSlackCall } from "./direct-message.js"
import { slackRunnerAvailable } from "./headless.js"
import { SLACK_CHOICE_PRESSED, SlackApiError, type SlackCall, type SlackEvent } from "./protocol.js"
import type { InstallationRow } from "./repository.js"
import { slackRichEnabled } from "./rich-delivery.js"
import { SLACK_CHOICE_PREFIX, SLACK_LIMITS } from "./rich-message.js"
import { slackSafeText } from "./slack-text.js"

export const slackInteractionSchema = z.object({
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  api_app_id: z.string(),
  channel: z.object({ id: z.string() }).optional(),
  container: z.object({ channel_id: z.string().optional(), message_ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
  message: z.object({ ts: z.string(), thread_ts: z.string().optional(), blocks: z.array(z.unknown()).optional() }).optional(),
  actions: z.array(z.object({ action_id: z.string(), block_id: z.string().optional(), value: z.string().optional(), action_ts: z.string().optional() })).optional(),
})
export type SlackInteraction = z.infer<typeof slackInteractionSchema>

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

export function slackChoicePress(payload: SlackInteraction): { eventId: string; event: SlackEvent } | null {
  const action = (payload.actions ?? []).find((entry) => entry.action_id.startsWith(SLACK_CHOICE_PREFIX) && entry.block_id?.startsWith(SLACK_CHOICE_PREFIX))
  const channel = payload.channel?.id ?? payload.container?.channel_id
  const messageTs = payload.message?.ts ?? payload.container?.message_ts
  const label = action?.value?.trim() ?? ""
  if (!action?.block_id || !channel || !messageTs || !label || label.length > SLACK_LIMITS.buttonText) return null
  if (offered(payload.message?.blocks, action.block_id, action.action_id, label) === false) return null
  const prompt = shownPrompt(payload.message?.blocks)
  const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts
  return {
    eventId: `press:${channel}:${messageTs}:${payload.user.id}:${action.action_ts ?? action.action_id}`,
    event: {
      type: SLACK_CHOICE_PRESSED,
      user: payload.user.id,
      channel,
      text: label,
      ts: messageTs,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      choice: { addressed: action.block_id.slice(SLACK_CHOICE_PREFIX.length), ...(prompt ? { prompt } : {}) },
    },
  }
}

export type SlackChoiceOutcome = "not_a_choice" | "not_addressed" | "unavailable" | "throttled" | "accepted" | "already_answered"

export type SlackChoiceInstallation = Pick<InstallationRow, "connectionId" | "teamId" | "enabled" | "botToken" | "channelIds">

export type SlackChoiceDeps = {
  slack: (installation: SlackChoiceInstallation) => Promise<SlackCall | null>
  record: (installation: SlackChoiceInstallation, eventId: string, event: SlackEvent) => Promise<{ created: boolean; event: SlackEvent } | null>
  available: () => boolean
  enabled: (installation: SlackChoiceInstallation, slackUserId: string) => Promise<boolean>
}

const defaultChoiceDeps: SlackChoiceDeps = {
  slack: async (installation) => (installation.botToken ? workbotSlackCall(installation.connectionId, installation.botToken, defaultWorkbotDirectMessageDeps) : null),
  record: async (installation, eventId, event) => (await import("./repository.js")).recordSlackEventOnce(installation, eventId, event),
  available: slackRunnerAvailable,
  enabled: async (installation, slackUserId) => {
    const { getInstallation, resolveSlackActor } = await import("./repository.js")
    const row = await getInstallation(installation.connectionId)
    const actor = row ? await resolveSlackActor(row, slackUserId) : null
    return actor ? slackRichEnabled(actor.organizationId, actor.userId) : false
  },
}

async function tell(slack: SlackCall | null, place: { channel: string; user: string; thread_ts?: string }, text: string) {
  if (!slack) return
  try {
    await slack("chat.postEphemeral", { ...place, text })
  } catch (error) {
    appLogger.warn("slack_choice_notice_failed", { code: error instanceof SlackApiError ? error.code : "request_failed" })
  }
}

export async function settleSlackChoice(installation: SlackChoiceInstallation, pressed: SlackEvent, deps: SlackChoiceDeps = defaultChoiceDeps): Promise<SlackChoiceOutcome> {
  const { user, channel, ts: messageTs, choice } = pressed
  const label = pressed.text?.trim() ?? ""
  if (pressed.type !== SLACK_CHOICE_PRESSED || !user || !channel || !messageTs || !choice || !label) return "not_a_choice"
  const direct = channel.startsWith("D")
  const slack = await deps.slack(installation)
  const place = { channel, user, ...(pressed.thread_ts ? { thread_ts: pressed.thread_ts } : {}) }
  if (user !== choice.addressed) {
    await tell(slack, place, /^[UW][A-Z0-9]{2,}$/.test(choice.addressed) ? `Only <@${choice.addressed}> can answer this.` : "This question is for someone else.")
    return "not_addressed"
  }
  const allowedChannel = direct || !installation.channelIds?.length || installation.channelIds.includes(channel)
  if (!installation.enabled || !deps.available() || !allowedChannel || !(await deps.enabled(installation, user))) {
    await tell(slack, place, "OpenWork isn't taking button answers here right now, so nothing was started. Reply in the thread instead.")
    return "unavailable"
  }
  const recorded = await deps.record(installation, `choice:${channel}:${messageTs}`, {
    type: direct ? "message" : "app_mention",
    ...(direct ? { channel_type: "im" } : {}),
    user,
    channel,
    text: label,
    ts: messageTs,
    thread_ts: pressed.thread_ts ?? messageTs,
  })
  if (!recorded) {
    await tell(slack, place, "Too many requests right now. Try again in a minute.")
    return "throttled"
  }
  const winner = recorded.event.text?.trim() || label
  if (!recorded.created && winner !== label) await tell(slack, place, `You already chose "${winner}", and that is what OpenWork is working on.`)
  const chosen = `<@${user}> chose "${slackSafeText(winner)}".`
  try {
    await slack?.("chat.update", {
      channel,
      ts: messageTs,
      text: choice.prompt ? `${choice.prompt}\n${chosen}` : chosen,
      blocks: [
        ...(choice.prompt ? [{ type: "section", text: { type: "mrkdwn", text: choice.prompt } }] : []),
        { type: "context", elements: [{ type: "mrkdwn", text: `✅ <@${user}> chose *${slackSafeText(winner)}*` }] },
      ],
    })
  } catch (error) {
    appLogger.warn("slack_choice_update_failed", { code: error instanceof SlackApiError ? error.code : "request_failed" })
  }
  return recorded.created ? "accepted" : "already_answered"
}
