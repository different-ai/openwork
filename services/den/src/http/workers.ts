import { randomBytes, randomUUID } from "crypto"
import express from "express"
import { fromNodeHeaders } from "better-auth/node"
import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { auth } from "../auth.js"
// Polar billing is temporarily disabled for the one-worker experiment.
// Keep the old billing integration nearby so it can be restored quickly.
// import { getCloudWorkerBillingStatus, setCloudWorkerSubscriptionCancellation } from "../billing/polar.js"
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
type OrgMembershipRow = typeof OrgMembershipTable.$inferSelect

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

async function getWorkerRuntimeAccess(workerId: string) {
  const instance = await getLatestWorkerInstance(workerId)
  const tokenRows = await db
    .select()
    .from(WorkerTokenTable)
    .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
    .orderBy(asc(WorkerTokenTable.created_at))

  const hostToken = tokenRows.find((entry) => entry.scope === "host")?.token ?? null
  if (!instance?.url || !hostToken) {
    return null
  }

  return {
    instance,
    hostToken,
    candidates: getConnectUrlCandidates(workerId, instance.url),
  }
}

async function fetchWorkerRuntimeJson(input: {
  workerId: string
  path: string
  method?: "GET" | "POST"
  body?: unknown
}) {
  const access = await getWorkerRuntimeAccess(input.workerId)
  if (!access) {
    return {
      ok: false as const,
      status: 409,
      payload: {
        error: "worker_runtime_unavailable",
        message: "Worker runtime access is not ready yet. Wait for provisioning to finish and try again.",
      },
    }
  }

  let lastPayload: unknown = null
  let lastStatus = 502

  for (const candidate of access.candidates) {
    try {
      const response = await fetch(`${normalizeUrl(candidate)}${input.path}`, {
        method: input.method ?? "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-OpenWork-Host-Token": access.hostToken,
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      })

      const text = await response.text()
      lastStatus = response.status
      try {
        lastPayload = text ? JSON.parse(text) : null
      } catch {
        lastPayload = text ? { message: text } : null
      }

      if (response.ok) {
        return { ok: true as const, status: response.status, payload: lastPayload }
      }
    } catch (error) {
      lastPayload = { message: error instanceof Error ? error.message : "worker_request_failed" }
    }
  }

  return { ok: false as const, status: lastStatus, payload: lastPayload }
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

async function getOrgMembership(userId: string): Promise<OrgMembershipRow | null> {
  const rows = await db
    .select()
    .from(OrgMembershipTable)
    .where(eq(OrgMembershipTable.user_id, userId))
    .limit(1)

  return rows[0] ?? null
}

function canAccessWorker(membership: OrgMembershipRow, worker: WorkerRow, userId: string) {
  return membership.role === "owner" || worker.created_by_user_id === userId
}

async function getAuthorizedWorker(userId: string, workerId: string) {
  const membership = await getOrgMembership(userId)
  if (!membership) {
    return { membership: null, worker: null }
  }

  const rows = await db
    .select()
    .from(WorkerTable)
    .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.org_id, membership.org_id)))
    .limit(1)

  const worker = rows[0] ?? null
  if (!worker || !canAccessWorker(membership, worker, userId)) {
    return { membership, worker: null }
  }

  return { membership, worker }
}

async function countUserCloudWorkers(userId: string) {
  const rows = await db
    .select({ id: WorkerTable.id })
    .from(WorkerTable)
    .where(and(eq(WorkerTable.created_by_user_id, userId), eq(WorkerTable.destination, "cloud")))
    .limit(2)

  return rows.length
}

function getExperimentBillingSummary() {
  return {
    featureGateEnabled: false,
    hasActivePlan: false,
    checkoutRequired: false,
    checkoutUrl: null,
    portalUrl: null,
    price: null,
    subscription: null,
    invoices: [],
    productId: env.polar.productId,
    benefitId: env.polar.benefitId,
  }
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

  const membership = await getOrgMembership(session.user.id)
  if (!membership) {
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
    .where(
      membership.role === "owner"
        ? eq(WorkerTable.org_id, membership.org_id)
        : and(
            eq(WorkerTable.org_id, membership.org_id),
            eq(WorkerTable.created_by_user_id, session.user.id),
          ),
    )
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

  if (parsed.data.destination === "cloud" && (await countUserCloudWorkers(session.user.id)) > 0) {
    // Polar is temporarily disabled for this experiment.
    // Keep the previous paywall block nearby so it can be restored quickly.
    //
    // const access = await requireCloudWorkerAccess({
    //   userId: session.user.id,
    //   email: session.user.email ?? `${session.user.id}@placeholder.local`,
    //   name: session.user.name ?? session.user.email ?? "OpenWork User",
    // })
    // if (!access.allowed) {
    //   res.status(402).json({
    //     error: "payment_required",
    //     message: "Additional cloud workers require an active Den Cloud plan.",
    //     polar: {
    //       checkoutUrl: access.checkoutUrl,
    //       productId: env.polar.productId,
    //       benefitId: env.polar.benefitId,
    //     },
    //   })
    //   return
    // }

    res.status(409).json({
      error: "worker_limit_reached",
      message: "You can only create one cloud worker during this experiment.",
    })
    return
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
      client: clientToken,
    },
    instance: null,
    launch: parsed.data.destination === "cloud" ? { mode: "async", pollAfterMs: 5000 } : { mode: "instant", pollAfterMs: 0 },
  })
}))

workersRouter.get("/billing", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  res.json({
    billing: getExperimentBillingSummary(),
  })

  // Polar billing is temporarily disabled for the one-worker experiment.
  // const includeCheckoutUrl = queryIncludesFlag(req.query.includeCheckout)
  // const includePortalUrl = !queryIncludesFlag(req.query.excludePortal)
  // const includeInvoices = !queryIncludesFlag(req.query.excludeInvoices)
  //
  // const billingInput = {
  //   userId: session.user.id,
  //   email: session.user.email ?? `${session.user.id}@placeholder.local`,
  //   name: session.user.name ?? session.user.email ?? "OpenWork User",
  // }
  //
  // const billing = await getCloudWorkerBillingStatus(
  //   billingInput,
  //   {
  //     includeCheckoutUrl,
  //     includePortalUrl,
  //     includeInvoices,
  //   },
  // )
  //
  // res.json({
  //   billing: {
  //     ...billing,
  //     productId: env.polar.productId,
  //     benefitId: env.polar.benefitId,
  //   },
  // })
}))

workersRouter.post("/billing/subscription", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const parsed = billingSubscriptionSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
    return
  }

  res.json({
    subscription: null,
    billing: getExperimentBillingSummary(),
  })

  // Polar billing is temporarily disabled for the one-worker experiment.
  // const billingInput = {
  //   userId: session.user.id,
  //   email: session.user.email ?? `${session.user.id}@placeholder.local`,
  //   name: session.user.name ?? session.user.email ?? "OpenWork User",
  // }
  //
  // const subscription = await setCloudWorkerSubscriptionCancellation(billingInput, parsed.data.cancelAtPeriodEnd)
  // const billing = await getCloudWorkerBillingStatus(billingInput, {
  //   includeCheckoutUrl: false,
  //   includePortalUrl: true,
  //   includeInvoices: true,
  // })
  //
  // res.json({
  //   subscription,
  //   billing: {
  //     ...billing,
  //     productId: env.polar.productId,
  //     benefitId: env.polar.benefitId,
  //   },
  // })
}))

workersRouter.get("/:id", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const { worker } = await getAuthorizedWorker(session.user.id, req.params.id)
  if (!worker) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const instance = await getLatestWorkerInstance(worker.id)

  res.json({
    worker: toWorkerResponse(worker, session.user.id),
    instance: toInstanceResponse(instance),
  })
}))

workersRouter.post("/:id/tokens", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const { worker } = await getAuthorizedWorker(session.user.id, req.params.id)
  if (!worker) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const tokenRows = await db
    .select()
    .from(WorkerTokenTable)
    .where(and(eq(WorkerTokenTable.worker_id, worker.id), isNull(WorkerTokenTable.revoked_at)))
    .orderBy(asc(WorkerTokenTable.created_at))

  const clientToken = tokenRows.find((entry) => entry.scope === "client")?.token ?? null

  if (!clientToken) {
    res.status(409).json({
      error: "worker_tokens_unavailable",
      message: "Worker tokens are missing for this worker. Launch a new worker and try again.",
    })
    return
  }

  const instance = await getLatestWorkerInstance(worker.id)
  const connect = await resolveConnectUrlFromCandidates(worker.id, instance?.url ?? null, clientToken)

  res.json({
    tokens: {
      client: clientToken,
    },
    connect: connect ?? (instance?.url ? { openworkUrl: instance.url, workspaceId: null } : null),
  })
}))

workersRouter.get("/:id/runtime", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const { worker } = await getAuthorizedWorker(session.user.id, req.params.id)
  if (!worker) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const runtime = await fetchWorkerRuntimeJson({
    workerId: worker.id,
    path: "/runtime/versions",
  })

  res.status(runtime.status).json(runtime.payload)
}))

workersRouter.post("/:id/runtime/upgrade", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const { worker } = await getAuthorizedWorker(session.user.id, req.params.id)
  if (!worker) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }

  const runtime = await fetchWorkerRuntimeJson({
    workerId: worker.id,
    path: "/runtime/upgrade",
    method: "POST",
    body: req.body ?? {},
  })

  res.status(runtime.status).json(runtime.payload)
}))

workersRouter.delete("/:id", asyncRoute(async (req, res) => {
  const session = await requireSession(req, res)
  if (!session) return

  const { worker } = await getAuthorizedWorker(session.user.id, req.params.id)
  if (!worker) {
    res.status(404).json({ error: "worker_not_found" })
    return
  }
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
