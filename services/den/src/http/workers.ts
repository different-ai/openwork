import { randomBytes, randomUUID } from "crypto"
import express from "express"
import { fromNodeHeaders } from "better-auth/node"
import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { auth } from "../auth.js"
import { getCloudWorkerBillingStatus, requireCloudWorkerAccess, setCloudWorkerSubscriptionCancellation } from "../billing/polar.js"
import { db } from "../db/index.js"
import { AuditEventTable, OrgMembershipTable, WorkerBundleTable, WorkerInstanceTable, WorkerTable, WorkerTokenTable } from "../db/schema.js"
import { env } from "../env.js"
import { asyncRoute, isTransientDbConnectionError } from "./errors.js"
import { ensureDefaultOrg } from "../orgs.js"
import { deprovisionWorker, provisionWorker } from "../workers/provisioner.js"
import { customDomainForWorker } from "../workers/vanity-domain.js"

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  destination: z.enum(["local", "cloud"]),
  workspacePath: z.string().optional(),
  sandboxBackend: z.string().optional(),
  imageVersion: z.string().optional(),
})

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

const billingSubscriptionSchema = z.object({
  cancelAtPeriodEnd: z.boolean().default(true),
})

const token = () => randomBytes(32).toString("hex")

type WorkerRow = typeof WorkerTable.$inferSelect
type WorkerInstanceRow = typeof WorkerInstanceTable.$inferSelect

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function parseWorkspaceSelection(payload: unknown): { workspaceId: string; openworkUrl: string } | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return null
  }

  const activeId = typeof payload.activeId === "string" ? payload.activeId : null
  let workspaceId = activeId

  if (!workspaceId) {
    for (const item of payload.items) {
      if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
        workspaceId = item.id
        break
      }
    }
  }

  const baseUrl = typeof payload.baseUrl === "string" ? normalizeUrl(payload.baseUrl) : ""
  if (!workspaceId || !baseUrl) {
    return null
  }

  return {
    workspaceId,
    openworkUrl: `${baseUrl}/w/${encodeURIComponent(workspaceId)}`,
  }
}

async function resolveConnectUrlFromWorker(instanceUrl: string, clientToken: string) {
  const baseUrl = normalizeUrl(instanceUrl)
  if (!baseUrl || !clientToken.trim()) {
    return null
  }

  try {
    const response = await fetch(`${baseUrl}/workspaces`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${clientToken.trim()}`,
      },
    })

    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as unknown
    const selected = parseWorkspaceSelection({
      ...(isRecord(payload) ? payload : {}),
      baseUrl,
    })
    return selected
  } catch {
    return null
  }
}

function getConnectUrlCandidates(workerId: string, instanceUrl: string | null) {
  const candidates: string[] = []
  const vanityHostname = customDomainForWorker(workerId, env.render.workerPublicDomainSuffix)
  if (vanityHostname) {
    candidates.push(`https://${vanityHostname}`)
  }

  if (instanceUrl) {
    const normalized = normalizeUrl(instanceUrl)
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized)
    }
  }

  return candidates
}

function queryIncludesFlag(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "1" || normalized === "true" || normalized === "yes"
  }

  if (Array.isArray(value)) {
    return value.some((entry) => queryIncludesFlag(entry))
  }

  return false
}

async function resolveConnectUrlFromCandidates(workerId: string, instanceUrl: string | null, clientToken: string) {
  const candidates = getConnectUrlCandidates(workerId, instanceUrl)
  for (const candidate of candidates) {
    const resolved = await resolveConnectUrlFromWorker(candidate, clientToken)
    if (resolved) {
      return resolved
    }
  }
  return null
}

async function requireSession(req: express.Request, res: express.Response) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })
  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }
  return session
}

async function getOrgId(userId: string) {
  const membership = await db
    .select()
    .from(OrgMembershipTable)
    .where(eq(OrgMembershipTable.user_id, userId))
    .limit(1)
  if (membership.length === 0) {
    return null
  }
  return membership[0].org_id
}

async function getLatestWorkerInstance(workerId: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rows = await db
        .select()
        .from(WorkerInstanceTable)
        .where(eq(WorkerInstanceTable.worker_id, workerId))
        .orderBy(desc(WorkerInstanceTable.created_at))
        .limit(1)

      return rows[0] ?? null
    } catch (error) {
      if (!isTransientDbConnectionError(error)) {
        throw error
      }

      if (attempt === 0) {
        console.warn(`[workers] transient db error reading instance for ${workerId}; retrying`)
        continue
      }

      console.warn(`[workers] transient db error reading instance for ${workerId}; returning null instance`)
      return null
    }
  }

  return null
}

function toInstanceResponse(instance: WorkerInstanceRow | null) {
  if (!instance) {
    return null
  }

  return {
    provider: instance.provider,
    region: instance.region,
    url: instance.url,
    status: instance.status,
    createdAt: instance.created_at,
    updatedAt: instance.updated_at,
  }
}

function toWorkerResponse(row: WorkerRow, userId: string) {
  return {
    id: row.id,
    orgId: row.org_id,
    createdByUserId: row.created_by_user_id,
    isMine: row.created_by_user_id === userId,
    name: row.name,
    description: row.description,
    destination: row.destination,
    status: row.status,
    imageVersion: row.image_version,
    workspacePath: row.workspace_path,
    sandboxBackend: row.sandbox_backend,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function continueCloudProvisioning(input: { workerId: string; name: string; hostToken: string; clientToken: string }) {
  try {
    const provisioned = await provisionWorker({
      workerId: input.workerId,
      name: input.name,
      hostToken: input.hostToken,
      clientToken: input.clientToken,
    })

    await db
      .update(WorkerTable)
      .set({ status: provisioned.status })
      .where(eq(WorkerTable.id, input.workerId))

    await db.insert(WorkerInstanceTable).values({
      id: randomUUID(),
      worker_id: input.workerId,
      provider: provisioned.provider,
      region: provisioned.region,
      url: provisioned.url,
      status: provisioned.status,
    })
  } catch (error) {
    await db
      .update(WorkerTable)
      .set({ status: "failed" })
      .where(eq(WorkerTable.id, input.workerId))

    const message = error instanceof Error ? error.message : "provisioning_failed"
    console.error(`[workers] provisioning failed for ${input.workerId}: ${message}`)
  }
}

export const workersRouter = express.Router()

workersRouter.get("/", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const orgId = await getOrgId(session.user.id)
  if (!orgId) {
    res.json({ workers: [] })
    return
  }

  const parsed = listSchema.safeParse({ limit: req.query.limit })
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const rows = await db
    .select()
    .from(WorkerTable)
    .where(eq(WorkerTable.org_id, orgId))
    .orderBy(desc(WorkerTable.created_at))
    .limit(parsed.data.limit)

  const workers = await Promise.all(
    rows.map(async (row) => {
      const instance = await getLatestWorkerInstance(row.id)
      return {
        ...toWorkerResponse(row, session.user.id),
        instance: toInstanceResponse(instance),
      }
    }),
  )

  res.json({ workers })
}))

workersRouter.post("/", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  if (parsed.data.destination === "local" && !parsed.data.workspacePath) {
    res.status(400).json({ error: "workspace_path_required" })
    return
  }

  if (parsed.data.destination === "cloud") {
    const access = await requireCloudWorkerAccess({
      userId: session.user.id,
      email: session.user.email ?? `${session.user.id}@placeholder.local`,
      name: session.user.name ?? session.user.email ?? "OpenWork User",
    })

    if (!access.allowed) {
      res.status(402).json({
        error: "payment_required",
        message: "Cloud workers require an active Den Cloud plan.",
        polar: {
          checkoutUrl: access.checkoutUrl,
          productId: env.polar.productId,
          benefitId: env.polar.benefitId,
        },
      })
      return
    }
  }

  const orgId =
    (await getOrgId(session.user.id)) ?? (await ensureDefaultOrg(session.user.id, session.user.name ?? session.user.email ?? "Personal"))
  const workerId = randomUUID()
  let workerStatus: WorkerRow["status"] = parsed.data.destination === "cloud" ? "provisioning" : "healthy"

  await db.insert(WorkerTable).values({
    id: workerId,
    org_id: orgId,
    created_by_user_id: session.user.id,
    name: parsed.data.name,
    description: parsed.data.description,
    destination: parsed.data.destination,
    status: workerStatus,
    image_version: parsed.data.imageVersion,
    workspace_path: parsed.data.workspacePath,
    sandbox_backend: parsed.data.sandboxBackend,
  })

  const hostToken = token()
  const clientToken = token()
  await db.insert(WorkerTokenTable).values([
    {
      id: randomUUID(),
      worker_id: workerId,
      scope: "host",
      token: hostToken,
    },
    {
      id: randomUUID(),
      worker_id: workerId,
      scope: "client",
      token: clientToken,
    },
  ])

  if (parsed.data.destination === "cloud") {
    void continueCloudProvisioning({
      workerId,
      name: parsed.data.name,
      hostToken,
      clientToken,
    })
  }

  res.status(parsed.data.destination === "cloud" ? 202 : 201).json({
    worker: toWorkerResponse(
      {
        id: workerId,
        org_id: orgId,
        created_by_user_id: session.user.id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        destination: parsed.data.destination,
        status: workerStatus,
        image_version: parsed.data.imageVersion ?? null,
        workspace_path: parsed.data.workspacePath ?? null,
        sandbox_backend: parsed.data.sandboxBackend ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      session.user.id,
    ),
    tokens: {
      host: hostToken,
      client: clientToken,
    },
    instance: null,
    launch: parsed.data.destination === "cloud" ? { mode: "async", pollAfterMs: 5000 } : { mode: "instant", pollAfterMs: 0 },
  })
}))

workersRouter.get("/billing", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const includeCheckoutUrl = queryIncludesFlag(req.query.includeCheckout)
  const includePortalUrl = !queryIncludesFlag(req.query.excludePortal)
  const includeInvoices = !queryIncludesFlag(req.query.excludeInvoices)

  const billingInput = {
    userId: session.user.id,
    email: session.user.email ?? `${session.user.id}@placeholder.local`,
    name: session.user.name ?? session.user.email ?? "OpenWork User",
  }

  const billing = await getCloudWorkerBillingStatus(
    billingInput,
    {
      includeCheckoutUrl,
      includePortalUrl,
      includeInvoices,
    },
  )

  res.json({
    billing: {
      ...billing,
      productId: env.polar.productId,
      benefitId: env.polar.benefitId,
    },
  })
}))

workersRouter.post("/billing/subscription", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const parsed = billingSubscriptionSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  const billingInput = {
    userId: session.user.id,
    email: session.user.email ?? `${session.user.id}@placeholder.local`,
    name: session.user.name ?? session.user.email ?? "OpenWork User",
  }

  const subscription = await setCloudWorkerSubscriptionCancellation(billingInput, parsed.data.cancelAtPeriodEnd)
  const billing = await getCloudWorkerBillingStatus(billingInput, {
    includeCheckoutUrl: false,
    includePortalUrl: true,
    includeInvoices: true,
  })

  res.json({
    subscription,
    billing: {
      ...billing,
      productId: env.polar.productId,
      benefitId: env.polar.benefitId,
    },
  })
}))

workersRouter.get("/:id", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const orgId = await getOrgId(session.user.id)
  if (!orgId) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const rows = await db
    .select()
    .from(WorkerTable)
    .where(and(eq(WorkerTable.id, req.params.id), eq(WorkerTable.org_id, orgId)))
    .limit(1)

  if (rows.length === 0) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const instance = await getLatestWorkerInstance(rows[0].id)

  res.json({
    worker: toWorkerResponse(rows[0], session.user.id),
    instance: toInstanceResponse(instance),
  })
}))

workersRouter.post("/:id/tokens", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const orgId = await getOrgId(session.user.id)
  if (!orgId) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const rows = await db
    .select()
    .from(WorkerTable)
    .where(eq(WorkerTable.id, req.params.id))
    .limit(1)

  if (rows.length === 0 || rows[0].org_id !== orgId) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const tokenRows = await db
    .select()
    .from(WorkerTokenTable)
    .where(and(eq(WorkerTokenTable.worker_id, rows[0].id), isNull(WorkerTokenTable.revoked_at)))
    .orderBy(asc(WorkerTokenTable.created_at))

  const hostToken = tokenRows.find((entry) => entry.scope === "host")?.token ?? null
  const clientToken = tokenRows.find((entry) => entry.scope === "client")?.token ?? null

  if (!hostToken || !clientToken) {
    res.status(409).json({
      error: "worker_tokens_unavailable",
      message: "Worker tokens are missing for this worker. Launch a new worker and try again.",
    })
    return
  }

  const instance = await getLatestWorkerInstance(rows[0].id)
  const connect = await resolveConnectUrlFromCandidates(rows[0].id, instance?.url ?? null, clientToken)

  res.json({
    tokens: {
      host: hostToken,
      client: clientToken,
    },
    connect: connect ?? (instance?.url ? { openworkUrl: instance.url, workspaceId: null } : null),
  })
}))

workersRouter.delete("/:id", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const orgId = await getOrgId(session.user.id)
  if (!orgId) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const rows = await db
    .select()
    .from(WorkerTable)
    .where(and(eq(WorkerTable.id, req.params.id), eq(WorkerTable.org_id, orgId)))
    .limit(1)

  if (rows.length === 0) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const worker = rows[0]
  const instance = await getLatestWorkerInstance(worker.id)

  if (worker.destination === "cloud") {
    try {
      await deprovisionWorker({
        workerId: worker.id,
        instanceUrl: instance?.url ?? null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "deprovision_failed"
      console.warn(`[workers] deprovision warning for ${worker.id}: ${message}`)
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(WorkerTokenTable).where(eq(WorkerTokenTable.worker_id, worker.id))
    await tx.delete(WorkerInstanceTable).where(eq(WorkerInstanceTable.worker_id, worker.id))
    await tx.delete(WorkerBundleTable).where(eq(WorkerBundleTable.worker_id, worker.id))
    await tx.delete(AuditEventTable).where(eq(AuditEventTable.worker_id, worker.id))
    await tx.delete(WorkerTable).where(eq(WorkerTable.id, worker.id))
  })

  res.status(204).end()
}))
