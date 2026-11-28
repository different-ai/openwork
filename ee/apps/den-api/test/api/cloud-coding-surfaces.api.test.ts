import assert from "node:assert/strict"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { CloudCodingPushApprovalTable as Approvals, CloudCodingTaskTable as Tasks, OAuthAccessTokenTable, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_WORKER_ID_HEADER, CLOUD_CODING_WORKER_PROOF_HEADER, cloudCodingGatewaySetupSchema, cloudCodingWorkerProofMessage } from "@openwork/types/den/cloud-coding"
import { z } from "zod"
import { startFakeGithub } from "./cloud-coding-fake-github.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, summary, text, type Call } from "./harness.js"

const restoreCatalog = stubPublicModelCatalog()
after(restoreCatalog)
const github = await startFakeGithub()
after(() => github.close())
const den = await bootDen({ env: { ...github.env, ...gatewayFixtureEnv, DEN_DEPLOYMENT: "cloud", DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { mintHeadlessTurnCredentials } = await import("../../src/headless-runner/resume-grants.js")
const { setCloudCodingTurnReaderForTests } = await import("../../src/cloud-coding/gateway/turn.js")
const owner = await den.createOrg(await den.signUp("Maya Chen"), "Acme Corp")
const sam = await den.newMember(owner.owner, owner.orgId, "Sam Rivera")
const other = await den.createOrg(await den.signUp("Leo Martin"), "Other Corp")
const organizationId = normalizeDenTypeId("organization", owner.orgId)
const manage = den.as(owner.owner, owner.orgId)
const mcpToken = await den.mintMcpToken(owner.owner, owner.orgId)
const anotherBearer = await den.mintMcpToken(owner.owner, owner.orgId)
assert.notEqual(mcpToken, anotherBearer)
const root = "/v1/cloud-coding"
const gateway = `${root}/gateway`
const guidanceUri = "openwork://agent/guidance.md"
const startArgs = { repository: "storefront", task: "Fix the checkout bug." }
const query = "fix a bug in the storefront repo and open a pull request"
const cloudCoding = /cloud coding|cloud-coding/i
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

function status(result: Call, expected: number) {
  assert.equal(result.status, expected, summary(result))
  return result.body
}

github.addRepository({ id: 11, full_name: "acme/storefront", default_branch: "main", private: true, archived: false })
github.addInstallation({ id: 51, account: { id: 7, login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null, html_url: `${github.url}/settings/installations/51`, repositoryIds: [11] })
github.addUser({ id: 1, name: "Maya Chen", login: "maya-chen", installationIds: [51] })
status(await den.setFeature(owner.orgId, "cloudCoding", true), 200)
for (const kind of ["install", "link"]) {
  const begin = status(await manage("POST", `${root}/github/${kind}/start`, kind === "install" ? { existing: true } : {}), 200)
  const redirect = new URL(text(field(begin, "redirectUrl"), "GitHub redirect"))
  status(await manage("POST", `${root}/github/callback`, { state: redirect.searchParams.get("state"), code: github.issueCode(1) }), 200)
}

async function rpc(token: string, method: string, params: object, proof: Record<string, string> = {}) {
  const result = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream", ...proof },
    body: { jsonrpc: "2.0", id: 1, method, params },
  })
  const body = status(result, 200)
  const data = result.text.split("\n").find(line => line.startsWith("data:"))
  const envelope = data ? JSON.parse(data.slice(5)) : body
  assert.equal(field(envelope, "error"), undefined, result.text)
  return field(envelope, "result")
}

async function tool(token: string, name: string, args: object, proof?: Record<string, string>) {
  const result = await rpc(token, "tools/call", { name, arguments: args }, proof)
  const [part] = z.array(z.object({ text: z.string().optional() })).parse(field(result, "content"))
  return JSON.parse(text(part?.text, "tool result"))
}

const execute = (token: string, action: string, args: object, proof?: Record<string, string>) => tool(token, "execute_capability", { name: `cloud-coding:${action}`, arguments: args }, proof)
const start = (token: string, args: object = startArgs, proof?: Record<string, string>) => execute(token, "start", args, proof)
const matches = async (token: string, proof?: Record<string, string>) => z.array(z.object({ name: z.string() })).parse(field(await tool(token, "search_capabilities", { query }, proof), "matches"))
const instructions = async (token: string, proof?: Record<string, string>) => text(field(await rpc(token, "initialize", {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "surface-test", version: "1" },
}, proof), "instructions"), "instructions")
const guidance = async (token: string, proof?: Record<string, string>) => {
  const result = await rpc(token, "resources/read", { uri: guidanceUri }, proof)
  return z.array(z.object({ text: z.string() })).parse(field(result, "contents")).map(part => part.text).join("\n")
}
const startedSchema = z.object({ taskId: z.string(), setupCommand: z.string(), workFolder: z.string(), status: z.literal("ready"), expiresInMinutes: z.literal(60) })
const setupCode = (command: string) => text(/--code "(occ_setup_[A-Za-z0-9_-]+)"/.exec(command)?.[1], "setup code")

async function assertUnsupported(proof?: Record<string, string>) {
  assert.equal((await matches(mcpToken, proof)).some(({ name }) => name.startsWith("cloud-coding:")), false)
  assert.doesNotMatch(await instructions(mcpToken, proof), cloudCoding)
  assert.doesNotMatch(await guidance(mcpToken, proof), cloudCoding)
  for (const [action, args] of [["start", startArgs], ["status", { taskId: "not-a-task" }], ["repositories", {}]] as const) {
    const result = await execute(mcpToken, action, args, proof)
    assert.equal(field(result, "error"), "unknown_capability")
    assert.doesNotMatch(JSON.stringify(result), /occ_setup_/)
  }
}

async function worker(orgId: string, userId: string, opts: { revoked?: boolean; destination?: "local" | "cloud" } = {}) {
  const workerId = createDenTypeId("worker")
  const secret = randomUUID()
  await db.insert(WorkerTable).values({ id: workerId, org_id: normalizeDenTypeId("org", orgId), created_by_user_id: normalizeDenTypeId("user", userId),
    destination: opts.destination ?? "cloud", name: "Test computer", status: "healthy" })
  await db.insert(WorkerTokenTable).values({ id: createDenTypeId("workerToken"), worker_id: workerId, scope: "activity", token: secret, revoked_at: opts.revoked ? new Date() : null })
  const proof = (bearer: string, key = secret) => ({ [CLOUD_CODING_WORKER_ID_HEADER]: workerId,
    [CLOUD_CODING_WORKER_PROOF_HEADER]: `v1.${createHmac("sha256", key).update(cloudCodingWorkerProofMessage(workerId, sha(bearer))).digest("hex")}` })
  return { workerId, proof }
}

const ownWorker = await worker(owner.orgId, owner.owner.userId)

test("desktop and invalid web proofs expose no Cloud coding capability or guidance and create nothing", async () => {
  const revoked = await worker(owner.orgId, owner.owner.userId, { revoked: true })
  const local = await worker(owner.orgId, owner.owner.userId, { destination: "local" })
  const anotherMember = await worker(owner.orgId, sam.userId)
  const anotherOrg = await worker(other.orgId, owner.owner.userId)
  for (const proof of [undefined, ownWorker.proof(mcpToken, "wrong-key"), ownWorker.proof(anotherBearer), revoked.proof(mcpToken),
    local.proof(mcpToken), anotherMember.proof(mcpToken), anotherOrg.proof(mcpToken)]) await assertUnsupported(proof)
  assert.equal((await db.$primary.select().from(Tasks)).length, 0)
  assert.equal((await db.$primary.select().from(Approvals)).length, 0)
})

test("valid Web proof offers Cloud coding and puts the task in the conversation's own work folder", async () => {
  const proof = ownWorker.proof(mcpToken)
  assert.ok((await matches(mcpToken, proof)).some(({ name }) => name === "cloud-coding:start"))
  assert.match(await instructions(mcpToken, proof), cloudCoding)
  assert.match(await guidance(mcpToken, proof), cloudCoding)
  const conversationId = "web-chat-42"
  const started = startedSchema.parse(await start(mcpToken, { ...startArgs, originSessionId: conversationId }, proof))
  const dir = `/tmp/openwork-cloud-coding/${sha(conversationId).slice(0, 16)}/${started.taskId}`
  assert.equal(started.workFolder, `${dir}/storefront`)
  assert.ok(started.setupCommand.startsWith(`mkdir -p "${dir}" && curl -fsSL `))
  assert.ok(started.setupCommand.endsWith(`--root "${dir}"`))
  const [row] = await db.$primary.select().from(Tasks).where(eq(Tasks.id, normalizeDenTypeId("cloudCodingTask", started.taskId)))
  assert.equal(row?.surface, "web")
  assert.equal(row?.workerId, ownWorker.workerId)
  assert.equal(row?.conversationId, conversationId)
  assert.equal(row?.runTokenId, null)
})

const sessionId = "ses_cloud_coding"
const models = await grantGatewayModels(den, owner.owner, owner.orgId, [owner.owner])
function mint(messageId: string, conversationId = sessionId) {
  return mintHeadlessTurnCredentials({ organizationId, userId: owner.owner.userId, memberId: owner.owner.memberId,
    sessionId: conversationId, messageId, model: models["gpt-6-luna"], indexKind: "workbot" })
}
const redeem = (code: string) => den.request(null, "POST", `${gateway}/setup`, { body: { code } })
const taskView = (token: string) => den.request(token, "GET", `${gateway}/task`)
const turnEnded = { error: "task_closed", message: "This credential ended with the turn. Call cloud-coding:start again with this taskId to continue." }

test("Workbot binds to the actual turn; renew, expiry, and release constrain the task credential", async (t) => {
  t.after(() => setCloudCodingTurnReaderForTests())
  const first = await mint("msg_first")
  const next = await mint("msg_next")
  const wrongChat = await mint("msg_other", "ses_other")
  assert.ok((await matches(first.token)).some(({ name }) => name === "cloud-coding:start"))
  assert.match(await instructions(first.token), cloudCoding)
  const started = startedSchema.parse(await start(first.token, { ...startArgs, originSessionId: "ignore-me" }))
  const taskId = normalizeDenTypeId("cloudCodingTask", started.taskId)
  assert.equal(started.workFolder, `/workspace/cloud-coding/${taskId}/storefront`)
  const [row] = await db.$primary.select().from(Tasks).where(eq(Tasks.id, taskId))
  assert.equal(row?.surface, "workbot")
  assert.equal(row?.conversationId, sessionId)
  assert.equal(row?.runTokenId, first.tokenId)
  assert.equal(row?.runnerMessageId, "msg_first")

  const code = setupCode(started.setupCommand)
  setCloudCodingTurnReaderForTests(async (task) => [{ messageId: task.runnerMessageId, status: "running" }])
  const initial = cloudCodingGatewaySetupSchema.parse(status(await redeem(code), 200))
  status(await taskView(initial.token), 200)
  assert.equal(field(status(await redeem(code), 401), "error"), "task_closed")
  setCloudCodingTurnReaderForTests(async (task) => [{ messageId: task.runnerMessageId, status: "completed" }, { messageId: "other", status: "running" }])
  assert.deepEqual(status(await taskView(initial.token), 401), turnEnded)
  setCloudCodingTurnReaderForTests(async (task) => [{ messageId: `${task.runnerMessageId}.background`, kind: "task", status: "running" }])
  status(await taskView(initial.token), 200)
  await db.update(OAuthAccessTokenTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(OAuthAccessTokenTable.id, normalizeDenTypeId("oauthAccessToken", first.tokenId)))
  assert.deepEqual(status(await taskView(initial.token), 401), turnEnded)

  const retry = { ...startArgs, taskId }
  assert.equal(field(await start(wrongChat.token, retry), "error"), "task_closed")
  assert.equal(field(await start(mcpToken, { ...retry, originSessionId: sessionId }, ownWorker.proof(mcpToken)), "error"), "task_closed")
  const renewed = startedSchema.parse(await start(next.token, retry))
  assert.equal(renewed.taskId, taskId)
  status(await taskView(initial.token), 401)
  const secondCode = setupCode(renewed.setupCommand)
  const replacement = cloudCodingGatewaySetupSchema.parse(status(await redeem(secondCode), 200))
  assert.notEqual(initial.token, replacement.token)
  status(await taskView(replacement.token), 200)
  await db.update(Tasks).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(Tasks.id, taskId))
  assert.equal(field(status(await taskView(replacement.token), 401), "error"), "task_closed")

  const expiryCode = setupCode(startedSchema.parse(await start(next.token, retry)).setupCommand)
  await db.update(Tasks).set({ setupCodeExpiresAt: new Date(Date.now() - 1000) }).where(eq(Tasks.id, taskId))
  assert.equal(field(status(await redeem(expiryCode), 401), "error"), "task_closed")
  const latestCode = setupCode(startedSchema.parse(await start(next.token, retry)).setupCommand)
  const released = cloudCodingGatewaySetupSchema.parse(status(await redeem(latestCode), 200))
  status(await den.request(released.token, "POST", `${gateway}/release`), 204)
  status(await den.request(released.token, "POST", `${gateway}/release`), 204)
  status(await taskView(released.token), 401)
  const evidence = await den.auditStorageText()
  assert.match(evidence, /cloud_coding\.task\.started/)
  assert.match(evidence, /ses_cloud_coding/)
  for (const secret of [code, secondCode, expiryCode, latestCode, initial.token, replacement.token, released.token, first.token, next.token]) {
    assert.equal(evidence.includes(secret), false)
  }
})
