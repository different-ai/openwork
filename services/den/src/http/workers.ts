import { randomBytes, randomUUID } from "crypto"
import express from "express"
import { fromNodeHeaders } from "better-auth/node"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { auth } from "../auth.js"
import { requireCloudWorkerAccess } from "../billing/polar.js"
import { db } from "../db/index.js"
import { OrgMembershipTable, WorkerInstanceTable, WorkerTable, WorkerTokenTable } from "../db/schema.js"
import { env } from "../env.js"
import { ensureDefaultOrg } from "../orgs.js"
import { provisionWorker } from "../workers/provisioner.js"

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  destination: z.enum(["local", "cloud"]),
  workspacePath: z.string().optional(),
  sandboxBackend: z.string().optional(),
  imageVersion: z.string().optional(),
})

const token = () => randomBytes(32).toString("hex")

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

export const workersRouter = express.Router()

workersRouter.post("/", async (req, res) => {
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
  let workerStatus: "provisioning" | "healthy" | "failed" | "stopped" =
    parsed.data.destination === "cloud" ? "provisioning" : "healthy"

  await db.insert(WorkerTable).values({
    id: workerId,
    org_id: orgId,
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

  let instance = null
  if (parsed.data.destination === "cloud") {
    try {
      const provisioned = await provisionWorker({
        workerId,
        name: parsed.data.name,
        hostToken,
        clientToken,
      })
      workerStatus = provisioned.status

      await db
        .update(WorkerTable)
        .set({ status: workerStatus })
        .where(eq(WorkerTable.id, workerId))

      await db.insert(WorkerInstanceTable).values({
        id: randomUUID(),
        worker_id: workerId,
        provider: provisioned.provider,
        region: provisioned.region,
        url: provisioned.url,
        status: provisioned.status,
      })
      instance = provisioned
    } catch (error) {
      await db
        .update(WorkerTable)
        .set({ status: "failed" })
        .where(eq(WorkerTable.id, workerId))

      const message = error instanceof Error ? error.message : "provisioning_failed"
      res.status(502).json({ error: "provisioning_failed", message })
      return
    }
  }

  res.status(201).json({
    worker: {
      id: workerId,
      orgId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      destination: parsed.data.destination,
      status: workerStatus,
      imageVersion: parsed.data.imageVersion ?? null,
      workspacePath: parsed.data.workspacePath ?? null,
      sandboxBackend: parsed.data.sandboxBackend ?? null,
    },
    tokens: {
      host: hostToken,
      client: clientToken,
    },
    instance,
  })
})

workersRouter.get("/:id", async (req, res) => {
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

  res.json({
    worker: {
      id: rows[0].id,
      orgId: rows[0].org_id,
      name: rows[0].name,
      description: rows[0].description,
      destination: rows[0].destination,
      status: rows[0].status,
      imageVersion: rows[0].image_version,
      workspacePath: rows[0].workspace_path,
      sandboxBackend: rows[0].sandbox_backend,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
    },
  })
})

workersRouter.post("/:id/tokens", async (req, res) => {
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

  const hostToken = token()
  const clientToken = token()
  await db.insert(WorkerTokenTable).values([
    {
      id: randomUUID(),
      worker_id: rows[0].id,
      scope: "host",
      token: hostToken,
    },
    {
      id: randomUUID(),
      worker_id: rows[0].id,
      scope: "client",
      token: clientToken,
    },
  ])

  res.json({
    tokens: {
      host: hostToken,
      client: clientToken,
    },
  })
})
