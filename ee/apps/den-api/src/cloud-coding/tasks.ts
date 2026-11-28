import { createHash, randomBytes } from "node:crypto"
import { and, eq, gt, inArray } from "@openwork-ee/den-db/drizzle"
import { CloudCodingRepositoryTable, CloudCodingTaskTable, type CloudCodingSurface, type CloudCodingTaskStatus } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_SETUP_CODE_TTL_MS, CLOUD_CODING_TASK_TOKEN_TTL_MS } from "@openwork/types/den/cloud-coding"
import { db } from "../db.js"

export type CloudCodingTaskRow = typeof CloudCodingTaskTable.$inferSelect
export type CloudCodingRepositoryRow = typeof CloudCodingRepositoryTable.$inferSelect

export const CLOUD_CODING_SETUP_CODE_PREFIX = "occ_setup_"
export const CLOUD_CODING_TASK_TOKEN_PREFIX = "occ_task_"

const OPEN_TASK_STATUSES: readonly CloudCodingTaskStatus[] = ["created", "running", "awaiting_approval", "pushed"]

type TaskScope = { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }

export type CloudCodingTaskOrigin = {
  surface: CloudCodingSurface
  conversationId: string | null
  runTokenId: string | null
  runnerMessageId: string | null
  workerId: string | null
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`
}

function newSetupCode(now: number) {
  const setupCode = newSecret(CLOUD_CODING_SETUP_CODE_PREFIX)
  return {
    setupCode,
    setupCodeHash: hashSecret(setupCode),
    setupCodeExpiresAt: new Date(now + CLOUD_CODING_SETUP_CODE_TTL_MS),
  }
}

export async function createCloudCodingTask(input: TaskScope & {
  repository: Pick<CloudCodingRepositoryRow, "id" | "githubRepositoryId" | "fullName">
  baseBranch: string
  title: string
  origin: CloudCodingTaskOrigin
  now?: number
}): Promise<{ task: CloudCodingTaskRow; setupCode: string }> {
  const id = createDenTypeId("cloudCodingTask")
  const code = newSetupCode(input.now ?? Date.now())
  await db.insert(CloudCodingTaskTable).values({
    id,
    organizationId: input.organizationId,
    orgMembershipId: input.memberId,
    repositoryId: input.repository.id,
    githubRepositoryId: input.repository.githubRepositoryId,
    repositoryFullName: input.repository.fullName,
    baseBranch: input.baseBranch,
    title: input.title.slice(0, 255),
    ...input.origin,
    setupCodeHash: code.setupCodeHash,
    setupCodeExpiresAt: code.setupCodeExpiresAt,
  })
  const [task] = await db.$primary.select().from(CloudCodingTaskTable).where(eq(CloudCodingTaskTable.id, id)).limit(1)
  if (!task) throw new Error("cloud_coding_task_not_created")
  return { task, setupCode: code.setupCode }
}

export async function findCloudCodingTask(input: TaskScope & { taskId: string }): Promise<CloudCodingTaskRow | null> {
  const [task] = await db.$primary.select().from(CloudCodingTaskTable).where(and(
    eq(CloudCodingTaskTable.id, normalizeDenTypeId("cloudCodingTask", input.taskId)),
    eq(CloudCodingTaskTable.organizationId, input.organizationId),
    eq(CloudCodingTaskTable.orgMembershipId, input.memberId),
  )).limit(1)
  return task ?? null
}

export async function renewCloudCodingSetupCode(input: TaskScope & { taskId: string; origin: CloudCodingTaskOrigin; now?: number }): Promise<string | null> {
  const code = newSetupCode(input.now ?? Date.now())
  return db.transaction(async (tx) => {
    const [task] = await tx.select({ id: CloudCodingTaskTable.id, status: CloudCodingTaskTable.status, surface: CloudCodingTaskTable.surface, conversationId: CloudCodingTaskTable.conversationId })
      .from(CloudCodingTaskTable).where(and(
        eq(CloudCodingTaskTable.id, normalizeDenTypeId("cloudCodingTask", input.taskId)),
        eq(CloudCodingTaskTable.organizationId, input.organizationId),
        eq(CloudCodingTaskTable.orgMembershipId, input.memberId),
      )).limit(1).for("update")
    if (!task || !OPEN_TASK_STATUSES.includes(task.status)) return null
    if (task.surface !== input.origin.surface || task.conversationId !== input.origin.conversationId) return null
    await tx.update(CloudCodingTaskTable).set({
      setupCodeHash: code.setupCodeHash,
      setupCodeExpiresAt: code.setupCodeExpiresAt,
      runTokenId: input.origin.runTokenId,
      runnerMessageId: input.origin.runnerMessageId,
      workerId: input.origin.workerId,
      tokenHash: null,
      tokenExpiresAt: null,
    }).where(eq(CloudCodingTaskTable.id, task.id))
    return code.setupCode
  })
}

export async function redeemCloudCodingSetupCode(input: { code: string; now?: number }): Promise<{ task: CloudCodingTaskRow; token: string; tokenExpiresAt: Date } | null> {
  if (!input.code.startsWith(CLOUD_CODING_SETUP_CODE_PREFIX)) return null
  const now = input.now ?? Date.now()
  const token = newSecret(CLOUD_CODING_TASK_TOKEN_PREFIX)
  const tokenExpiresAt = new Date(now + CLOUD_CODING_TASK_TOKEN_TTL_MS)
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(CloudCodingTaskTable).where(and(
      eq(CloudCodingTaskTable.setupCodeHash, hashSecret(input.code)),
      gt(CloudCodingTaskTable.setupCodeExpiresAt, new Date(now)),
    )).limit(1).for("update")
    if (!task || !OPEN_TASK_STATUSES.includes(task.status)) return null
    const status = task.status === "created" ? "running" : task.status
    const changes = { setupCodeHash: null, setupCodeExpiresAt: null, tokenHash: hashSecret(token), tokenExpiresAt, status }
    await tx.update(CloudCodingTaskTable).set(changes).where(eq(CloudCodingTaskTable.id, task.id))
    return { task: { ...task, ...changes }, token, tokenExpiresAt }
  })
}

export async function releaseCloudCodingTaskCredential(task: Pick<CloudCodingTaskRow, "id" | "tokenHash">): Promise<void> {
  if (!task.tokenHash) return
  await db.update(CloudCodingTaskTable).set({ tokenHash: null, tokenExpiresAt: null, setupCodeHash: null, setupCodeExpiresAt: null })
    .where(and(eq(CloudCodingTaskTable.id, task.id), eq(CloudCodingTaskTable.tokenHash, task.tokenHash)))
}

export async function findCloudCodingTaskByToken(input: { token: string; now?: number }): Promise<CloudCodingTaskRow | null> {
  if (!input.token.startsWith(CLOUD_CODING_TASK_TOKEN_PREFIX)) return null
  const [task] = await db.$primary.select().from(CloudCodingTaskTable).where(and(
    eq(CloudCodingTaskTable.tokenHash, hashSecret(input.token)),
    gt(CloudCodingTaskTable.tokenExpiresAt, new Date(input.now ?? Date.now())),
    inArray(CloudCodingTaskTable.status, [...OPEN_TASK_STATUSES]),
  )).limit(1)
  return task ?? null
}

export async function closeCloudCodingTasksForMember(
  input: TaskScope & { failureCode: string },
  database: Pick<typeof db, "update"> = db,
): Promise<void> {
  await database.update(CloudCodingTaskTable).set({ status: "cancelled", failureCode: input.failureCode, tokenHash: null, setupCodeHash: null })
    .where(and(
      eq(CloudCodingTaskTable.organizationId, input.organizationId),
      eq(CloudCodingTaskTable.orgMembershipId, input.memberId),
      inArray(CloudCodingTaskTable.status, [...OPEN_TASK_STATUSES]),
    ))
}
