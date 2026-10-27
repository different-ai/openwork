import assert from "node:assert/strict"
import { test } from "node:test"

// Importing these modules never touches the database; the values only satisfy env validation.
for (const [name, value] of Object.entries({
  OPENWORK_DEV_MODE: "1",
  DB_MODE: "mysql",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:8790",
  DEN_DOCUMENTS_EDITOR: "cloud-worker",
  DEN_DOCUMENTS_HOST_ORIGIN: "https://workbot.example.com",
  DEN_DOCUMENTS_CALLBACK_BASE_URL: "https://api.example.com",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

const { placeOfficeEditor } = await import("../src/documents-office-editor.ts")
const { documentsEditorForWorkers } = await import("../src/workers/cloud-runtime.ts")
const { resolveCloudWorkerInterruptibility } = await import("../src/workers/cloud-activity.ts")
type Deps = NonNullable<Parameters<typeof placeOfficeEditor>[1]>
type Access = Awaited<ReturnType<Deps["resolveAccess"] & {}>>

const member = { organizationId: "org_01k00000000000000000000000", userId: "usr_01k00000000000000000000000" }
const workerId = "wrk_01k00000000000000000000000" as Access extends { workerId: infer W } ? W : never

function deps(sequence: Access[], overrides: Partial<Deps> = {}) {
  let clock = 0
  const calls = { resolve: 0, ensure: 0, endpoint: 0 }
  const value: Partial<Deps> = {
    hostingAvailable: () => true,
    webAccess: async () => ({ hasAccess: true }),
    resolveAccess: async () => { calls.resolve++; return sequence[Math.min(calls.resolve, sequence.length) - 1] },
    ensureWorker: async () => { calls.ensure++ },
    editorEndpoint: async () => { calls.endpoint++; return { url: "https://9980-signed.proxy.example.com" } },
    now: () => clock,
    sleep: async ms => { clock += ms },
    ...overrides,
  }
  return { value, calls }
}

const ready = { status: "ready", workerId, url: "https://8787-signed.proxy.example.com", expiresAt: new Date(), clientToken: "c", hostToken: "h" } as Access

test("an organization without OpenWork Web gets Open in Drive and never starts a worker", async () => {
  const { value, calls } = deps([ready], { webAccess: async () => ({ hasAccess: false }) })
  const placement = await placeOfficeEditor(member, value)
  assert.equal(placement.status, "unavailable")
  assert.match(placement.status === "unavailable" ? placement.message : "", /open this file in Drive/)
  assert.deepEqual(calls, { resolve: 0, ensure: 0, endpoint: 0 })
})

test("a member without a Cloud worker gets one created once, then a retryable starting result", async () => {
  const { value, calls } = deps([{ status: "missing" }, { status: "provisioning", workerId } as Access])
  const placement = await placeOfficeEditor(member, value, 4_000)
  assert.equal(placement.status, "starting")
  assert.equal(calls.ensure, 1)
  assert.equal(calls.endpoint, 0)
})

test("a waking worker that becomes ready returns its own signed editor URL", async () => {
  const { value, calls } = deps([{ status: "waking", workerId, reason: "stopped" } as Access, ready])
  const placement = await placeOfficeEditor(member, value)
  assert.deepEqual(placement, { status: "ready", serverUrl: "https://9980-signed.proxy.example.com", workerId })
  assert.equal(calls.ensure, 0)
})

test("a worker that needs repair is reported instead of waited on", async () => {
  const { value, calls } = deps([{ status: "failed", workerId } as Access])
  const placement = await placeOfficeEditor(member, value)
  assert.equal(placement.status, "unavailable")
  assert.equal(calls.resolve, 1)
})

test("workers allow only Den as the editor's WOPI host and only Workbot to embed it", () => {
  assert.deepEqual(documentsEditorForWorkers(), { port: 9980, wopiHost: "https://api.example.com:443", frameAncestor: "https://workbot.example.com" })
})

test("an open Office session keeps idle stop and updates away from the worker", async () => {
  const decision = await resolveCloudWorkerInterruptibility({
    workerId,
    trigger: "idle_stop",
    hasActiveAutomationRun: async () => false,
    hasOpenDocumentSession: async () => true,
    instance: async () => { throw new Error("the instance is not asked while a document is open") },
  })
  assert.deepEqual(decision, { verdict: "busy", reason: "document_session", activity: null })
})
