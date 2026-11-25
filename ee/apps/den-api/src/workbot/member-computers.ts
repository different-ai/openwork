import { workbotOwner, workbotSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps, type HeadlessRunnerDeps } from "../headless-runner/client.js"

const CHAT_LIMIT = 200

type Member = { organizationId: string; memberId: string }

export async function removeMemberWorkbotComputers(
  member: Member,
  deps: HeadlessRunnerDeps | null = defaultHeadlessRunnerDeps(),
): Promise<{ checked: number; failed: number }> {
  if (!deps) return { checked: 0, failed: 0 }
  const owner = workbotOwner(member.organizationId, member.memberId)
  const client = createHeadlessRunnerClient({ ...deps, config: { ...deps.config, owner } })
  const ids = new Set([workbotSessionId(member.organizationId, member.memberId)])
  const listed = await client.listSessions(owner, { limit: CHAT_LIMIT }).catch(() => null)
  for (const session of listed?.ok ? listed.value.sessions : []) ids.add(session.id)
  let checked = 0
  let failed = listed?.ok ? 0 : 1
  for (const id of ids) {
    const result = await client.deleteComputer(id).catch(() => null)
    if (result?.ok) checked++
    else if (result?.error !== "unknown_session") failed++
  }
  return { checked, failed }
}

export function removeMemberWorkbotComputersInBackground(member: Member) {
  void removeMemberWorkbotComputers(member).then(
    (result) => {
      if (result.checked || result.failed) console.log("[workbot] removed a former member's computers", { ...member, ...result })
    },
    (error: unknown) => console.error("[workbot] removing a former member's computers failed", { ...member, error: error instanceof Error ? error.message : "unknown" }),
  )
}
