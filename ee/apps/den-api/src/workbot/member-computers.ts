import { workbotOwner, workbotSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps, type HeadlessRunnerDeps } from "../headless-runner/client.js"

/** The most chats the runner lists at once. */
const CHAT_LIMIT = 200

type Member = { organizationId: string; memberId: string }

/**
 * Deletes the Workbot computers of someone who is no longer a member. Each holds their browser sign-ins and working
 * files, and would otherwise stay at the provider until its keep window ends. Their chats and kept files are left
 * alone, so someone who is invited back still has them and gets a new computer on first use.
 *
 * Best effort: a chat that is answering right now, or a runner that can't be reached, counts in `failed` and is left
 * to the provider's keep window. `checked` chats have no computer any more.
 */
export async function removeMemberWorkbotComputers(
  member: Member,
  deps: HeadlessRunnerDeps | null = defaultHeadlessRunnerDeps(),
): Promise<{ checked: number; failed: number }> {
  if (!deps) return { checked: 0, failed: 0 }
  const owner = workbotOwner(member.organizationId, member.memberId)
  const client = createHeadlessRunnerClient({ ...deps, config: { ...deps.config, owner } })
  // The main chat's id is derived, so it is tried even when it isn't listed (a computer opened before any message).
  const ids = new Set([workbotSessionId(member.organizationId, member.memberId)])
  const listed = await client.listSessions(owner, { limit: CHAT_LIMIT }).catch(() => null)
  for (const session of listed?.ok ? listed.value.sessions : []) ids.add(session.id)
  let checked = 0
  let failed = listed?.ok ? 0 : 1
  for (const id of ids) {
    const result = await client.deleteComputer(id).catch(() => null)
    if (result?.ok) checked++
    // No such chat: nothing of theirs is there. Any other answer, a runner that can't do this yet included, is a failure.
    else if (result?.error !== "unknown_session") failed++
  }
  return { checked, failed }
}

/** Starts the cleanup without holding the request that removed the member: a provider can take seconds per computer. */
export function removeMemberWorkbotComputersInBackground(member: Member) {
  void removeMemberWorkbotComputers(member).then(
    (result) => {
      if (result.checked || result.failed) console.log("[workbot] removed a former member's computers", { ...member, ...result })
    },
    (error: unknown) => console.error("[workbot] removing a former member's computers failed", { ...member, error: error instanceof Error ? error.message : "unknown" }),
  )
}
