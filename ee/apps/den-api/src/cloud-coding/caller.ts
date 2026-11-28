import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { HeadlessResumeGrantTable, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_WORKER_ID_HEADER, CLOUD_CODING_WORKER_PROOF_HEADER, CLOUD_CODING_WORKER_PROOF_VERSION, cloudCodingWorkerProofMessage } from "@openwork/types/den/cloud-coding"
import { db } from "../db.js"
import { eventThreadForPrincipal } from "../mcp-events/context.js"
import { readBearerToken, type McpPrincipal } from "../mcp/auth.js"
import { headlessRunTokenId } from "../mcp/headless-run-token.js"
import { cloudCodingSlackOrigin } from "./slack/origin.js"
import type { CloudCodingTaskOrigin } from "./tasks.js"

export async function resolveCloudCodingCaller(principal: McpPrincipal, headers: Headers): Promise<CloudCodingTaskOrigin | null> {
  const organizationId = normalizeDenTypeId("organization", principal.organizationId)
  const runTokenId = headlessRunTokenId(principal.payload)
  if (runTokenId) {
    const slack = await cloudCodingSlackOrigin({ runTokenId, organizationId, userId: principal.userId })
    if (slack) return { surface: "slack", conversationId: slack.sessionId, runnerMessageId: slack.runnerMessageId, runTokenId, workerId: null }
    const turn = await eventThreadForPrincipal(principal)
    const [grant] = turn?.resumeGrantId ? await db.$primary.select({ messageId: HeadlessResumeGrantTable.messageId })
      .from(HeadlessResumeGrantTable).where(eq(HeadlessResumeGrantTable.id, turn.resumeGrantId)).limit(1) : []
    return { surface: "workbot", conversationId: turn?.sessionId ?? null, runnerMessageId: grant?.messageId ?? null, runTokenId, workerId: null }
  }

  const workerId = headers.get(CLOUD_CODING_WORKER_ID_HEADER)
  const proof = new RegExp(`^${CLOUD_CODING_WORKER_PROOF_VERSION}\\.([0-9a-fA-F]{64})$`).exec(headers.get(CLOUD_CODING_WORKER_PROOF_HEADER) ?? "")?.[1]
  const bearer = readBearerToken(headers)
  if (!workerId || !isDenTypeId("worker", workerId) || !proof || !bearer) return null
  const tokens = await db.$primary.select({ token: WorkerTokenTable.token }).from(WorkerTokenTable)
    .innerJoin(WorkerTable, eq(WorkerTable.id, WorkerTokenTable.worker_id)).where(and(
      eq(WorkerTable.id, workerId), eq(WorkerTable.org_id, normalizeDenTypeId("org", organizationId)),
      eq(WorkerTable.created_by_user_id, normalizeDenTypeId("user", principal.userId)), eq(WorkerTable.destination, "cloud"),
      eq(WorkerTokenTable.scope, "activity"), isNull(WorkerTokenTable.revoked_at),
    ))
  const presented = Buffer.from(proof, "hex")
  const message = cloudCodingWorkerProofMessage(workerId, createHash("sha256").update(bearer).digest("hex"))
  const valid = tokens.some(({ token }) => timingSafeEqual(presented, createHmac("sha256", token).update(message).digest()))
  return valid ? { surface: "web", conversationId: null, runTokenId: null, runnerMessageId: null, workerId } : null
}
