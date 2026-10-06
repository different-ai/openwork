import { and, eq } from "@openwork-ee/den-db/drizzle"
import { SlackInstallationTable } from "@openwork-ee/den-db/schema"
import { z } from "zod"
import { db } from "../db.js"
import { env } from "../env.js"
import type { SlackHomeGrant } from "./generic-oauth.js"
import { slackHomePolicyError } from "./slack-policy.js"

export async function saveSlackInstallation(clientId: string, workspaceId: string, grant: SlackHomeGrant) {
  await db.insert(SlackInstallationTable).values({ clientId, workspaceId, ...grant })
    .onDuplicateKeyUpdate({ set: { ...grant, updatedAt: new Date() } })
}

const refreshSchema = z.object({
  ok: z.literal(true), token_type: z.literal("bot"),
  access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive(),
  team: z.object({ id: z.string() }),
})

async function boundedRefreshBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Slack Home refresh unavailable")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 64 * 1024) {
        await reader.cancel()
        throw new Error("Slack Home refresh response oversized")
      }
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally { reader.releaseLock() }
}

/** Workspace-scoped bot authority used only for static Home, never member lookups. */
export async function getSlackHomeToken(workspaceId: string, signal: AbortSignal): Promise<string | null> {
  const clientId = env.slackClientId
  const clientSecret = env.slackClientSecret
  if (await slackHomePolicyError() || !clientId || !clientSecret) return null
  const matches = and(eq(SlackInstallationTable.clientId, clientId), eq(SlackInstallationTable.workspaceId, workspaceId))
  // Serialize a rotating bot grant across replicas. No installation can borrow
  // another workspace's token. Hold only this row during the bounded refresh.
  return db.transaction(async (tx) => {
    const [installation] = await tx.select().from(SlackInstallationTable).where(matches).limit(1).for("update")
    signal.throwIfAborted()
    if (!installation) return null
    if (!installation.expiresAt || installation.expiresAt.getTime() > Date.now() + 60_000) return installation.accessToken
    if (!installation.refreshToken) return null
    const response = await fetch(env.slackOAuthTokenUrl ?? "https://slack.com/api/oauth.v2.access", {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: installation.refreshToken }),
    })
    if (!response.ok) { await response.body?.cancel(); return null }
    const refreshed = refreshSchema.safeParse(await boundedRefreshBody(response, signal))
    if (!refreshed.success || refreshed.data.team.id !== workspaceId || await slackHomePolicyError()
      || env.slackClientId !== clientId || env.slackClientSecret !== clientSecret) return null
    signal.throwIfAborted()
    await tx.update(SlackInstallationTable).set({ accessToken: refreshed.data.access_token, refreshToken: refreshed.data.refresh_token,
      expiresAt: new Date(Date.now() + refreshed.data.expires_in * 1000), updatedAt: new Date() }).where(matches)
    return refreshed.data.access_token
  })
}
