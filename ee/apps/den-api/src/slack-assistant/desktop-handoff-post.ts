import { DESKTOP_HANDOFF_REST_LINE, desktopHandoffMessage, desktopHandoffRichMessages, type DesktopHandoffNotice } from "./desktop-handoff-messages.js"
import type { SlackCall } from "./protocol.js"
import { logSlackBlocksRejected } from "./rich-delivery.js"
import { postSlackFollowUps, postSlackMessage, type SlackComposeOptions } from "./rich-message.js"

export type DesktopHandoffPlace = { channelId: string; threadTs: string; recipientUserId: string; organizationId: string; userId: string }
export type DesktopHandoffRich = (handoff: Pick<DesktopHandoffPlace, "organizationId" | "userId">) => Promise<Pick<SlackComposeOptions, "places" | "imageUrl"> | null>

export async function postDesktopHandoffNotice(slack: SlackCall, handoff: DesktopHandoffPlace, notice: DesktopHandoffNotice, rich?: DesktopHandoffRich) {
  const place = { channel: handoff.channelId, thread_ts: handoff.threadTs }
  const options = notice.kind === "finished" ? await rich?.(handoff) : null
  const composed = options ? desktopHandoffRichMessages(handoff.recipientUserId, notice, options) : null
  const [lead, ...rest] = composed?.messages ?? []
  if (!composed || !lead) {
    await slack("chat.postMessage", { ...place, ...desktopHandoffMessage(handoff.recipientUserId, notice), unfurl_links: false, unfurl_media: false })
    return
  }
  const onRejected = (code: string) => logSlackBlocksRejected("desktop_handoff", code)
  await postSlackMessage(slack, place, lead, { onRejected })
  const complete = await postSlackFollowUps(slack, place, rest, onRejected)
  if (composed.cut || !complete) await slack("chat.postMessage", { ...place, text: DESKTOP_HANDOFF_REST_LINE }).catch(() => undefined)
}
