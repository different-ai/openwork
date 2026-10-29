import { createHash } from "node:crypto"

/** Server-only deterministic identity shared by Workbot and trusted authorization services. */
export const workbotPersonKey = (organizationId: string, memberId: string) => createHash("sha256").update(`workbot:${organizationId}:${memberId}`).digest("hex").slice(0, 40)

/** Derived, so each member has exactly one main chat and Den stores nothing to find it. */
export function workbotSessionId(organizationId: string, memberId: string) {
  return `hs_wb_${workbotPersonKey(organizationId, memberId)}`
}

/** A side chat's id, made by the page when the person starts one. */
export const WORKBOT_CHAT_ID = /^[a-z0-9]{16,40}$/

/** The runner lists a person's chats by this key: derived from them, never their raw ids. */
export function workbotOwner(organizationId: string, memberId: string) {
  return `wb:${workbotPersonKey(organizationId, memberId)}`
}

/** A side chat's conversation: derived from the person and the chat's id, so nobody can reach another person's chat. */
export function workbotSideChatSessionId(organizationId: string, memberId: string, chatId: string) {
  return `hs_wbs_${createHash("sha256").update(`workbot:${organizationId}:${memberId}:${chatId}`).digest("hex").slice(0, 40)}`
}
