import { and, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import { OAuthAccessTokenTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { workbotOwner } from "@openwork-ee/headless-protocol/workbot-routing"
import { db } from "../../db.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps } from "../../headless-runner/client.js"
import type { CloudCodingTaskRow } from "../tasks.js"
import { CloudCodingChangeRefusal } from "./git-objects.js"

const turnEnded = () => new CloudCodingChangeRefusal("task_closed", "This credential ended with the turn. Call cloud-coding:start again with this taskId to continue.")
type BoundTask = CloudCodingTaskRow & { conversationId: string; runnerMessageId: string }
type RunnerTurn = { messageId: string; status: string; kind?: string }
type ReadTurns = (task: BoundTask) => Promise<readonly RunnerTurn[] | null>

const readTurns: ReadTurns = async (task) => {
  const deps = defaultHeadlessRunnerDeps(process.env, { indexKind: task.surface === "slack" ? "slack" : "workbot", memberId: task.orgMembershipId })
  if (!deps) return null
  const owner = task.surface === "workbot" ? workbotOwner(task.organizationId, task.orgMembershipId) : undefined
  const runner = createHeadlessRunnerClient(owner ? { ...deps, config: { ...deps.config, owner } } : deps)
  const result = await runner.readSession(task.conversationId, {
    messageId: task.runnerMessageId, limit: 1, outputs: "none", expectedOwner: owner,
  })
  return result.ok ? result.value.turns : []
}

const cache = new Map<string, { until: number; running: Promise<boolean> }>()
let read = readTurns

export function setCloudCodingTurnReaderForTests(reader?: ReadTurns): void {
  read = reader ?? readTurns
  cache.clear()
}

export async function requireCloudCodingTurn(task: CloudCodingTaskRow): Promise<void> {
  if (!task.runTokenId) return
  const [token] = await db.$primary.select({ id: OAuthAccessTokenTable.id }).from(OAuthAccessTokenTable).where(and(
    eq(OAuthAccessTokenTable.id, normalizeDenTypeId("oauthAccessToken", task.runTokenId)), gt(OAuthAccessTokenTable.expiresAt, new Date()),
    isNull(OAuthAccessTokenTable.revoked),
  )).limit(1)
  if (!token) throw turnEnded()
  const { conversationId, runnerMessageId } = task
  if (!conversationId || !runnerMessageId) return
  const key = JSON.stringify([task.id, task.runTokenId, conversationId, runnerMessageId])
  const now = Date.now()
  let cached = cache.get(key)
  if (!cached || cached.until <= now) {
    const running = read({ ...task, conversationId, runnerMessageId }).then((turns) => turns === null || turns.some((turn) =>
      turn.status === "running" && (turn.messageId === runnerMessageId || (turn.kind === "task" && turn.messageId.startsWith(`${runnerMessageId}.`))),
    )).catch(() => false)
    cached = { until: now + 3000, running }
    for (const [id, entry] of cache) if (entry.until <= now) cache.delete(id)
    if (cache.size < 1024) cache.set(key, cached)
  }
  if (!await cached.running) throw turnEnded()
}
