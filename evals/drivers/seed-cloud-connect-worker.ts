import { and, eq } from "../../ee/packages/den-db/src/drizzle.js"
import {
  OrganizationTable,
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
} from "../../ee/packages/den-db/src/schema.js"
import { createDenTypeId } from "../../ee/packages/utils/src/typeid.js"
import { db } from "../../ee/apps/den-api/src/db.js"

const organizationSlug = process.env.DEN_DEMO_ORG_SLUG?.trim() || "acme-robotics-demo"
const workerName = process.env.OPENWORK_EVAL_CLOUD_CONNECT_WORKER_NAME?.trim() || "Cloud Connect Test Worker"
const workerUrl = process.env.OPENWORK_EVAL_CLOUD_CONNECT_WORKER_URL?.trim() || "http://127.0.0.1:3979/worker"
const hostToken = process.env.OPENWORK_EVAL_CLOUD_CONNECT_HOST_TOKEN?.trim() || "mock-worker-host-token"
const clientToken = process.env.OPENWORK_EVAL_CLOUD_CONNECT_CLIENT_TOKEN?.trim() || "mock-worker-client-token"

async function seed() {
  const organizations = await db
    .select({ id: OrganizationTable.id })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.slug, organizationSlug))
    .limit(1)
  const organization = organizations[0]
  if (!organization) throw new Error(`Organization ${organizationSlug} was not found. Seed the demo org first.`)

  const existingWorkers = await db
    .select({ id: WorkerTable.id })
    .from(WorkerTable)
    .where(and(eq(WorkerTable.org_id, organization.id), eq(WorkerTable.name, workerName)))
    .limit(1)
  const workerId = existingWorkers[0]?.id ?? createDenTypeId("worker")

  if (existingWorkers[0]) {
    await db
      .update(WorkerTable)
      .set({ destination: "cloud", status: "healthy", sandbox_backend: "mock", last_heartbeat_at: new Date() })
      .where(eq(WorkerTable.id, workerId))
  } else {
    await db.insert(WorkerTable).values({
      id: workerId,
      org_id: organization.id,
      created_by_user_id: null,
      name: workerName,
      description: "Deterministic worker for the Telegram Cloud Connect fraimz flow.",
      destination: "cloud",
      status: "healthy",
      sandbox_backend: "mock",
      last_heartbeat_at: new Date(),
    })
  }

  await db.delete(WorkerTokenTable).where(eq(WorkerTokenTable.worker_id, workerId))
  await db.delete(WorkerInstanceTable).where(eq(WorkerInstanceTable.worker_id, workerId))
  await db.insert(WorkerTokenTable).values([
    { id: createDenTypeId("workerToken"), worker_id: workerId, scope: "host", token: hostToken },
    { id: createDenTypeId("workerToken"), worker_id: workerId, scope: "client", token: clientToken },
  ])
  await db.insert(WorkerInstanceTable).values({
    id: createDenTypeId("workerInstance"),
    worker_id: workerId,
    provider: "mock",
    region: "daytona",
    url: workerUrl,
    status: "healthy",
  })

  process.stdout.write(`${JSON.stringify({ organizationId: organization.id, workerId, workerName, workerUrl })}\n`)
}

seed()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
