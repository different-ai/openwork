import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test, type TestContext } from "node:test"
import { createAdaptorServer } from "@hono/node-server"
import { eq } from "@openwork-ee/den-db/drizzle"
import { CloudCodingPushApprovalTable as Approvals, CloudCodingTaskTable as Tasks, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_WORKER_ID_HEADER, CLOUD_CODING_WORKER_PROOF_HEADER, cloudCodingOverviewSchema, cloudCodingPushApprovalListSchema, cloudCodingPushApprovalSchema, cloudCodingWorkerProofMessage, type CloudCodingPushApproval } from "@openwork/types/den/cloud-coding"
import { z } from "zod"
import { startFakeGithubGit } from "./cloud-coding-fake-github-git.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, summary, text, type Call } from "./harness.js"

let serveDen: ((request: Request) => Response | Promise<Response>) | undefined
const listener = createAdaptorServer({ fetch: request => serveDen ? serveDen(request) : new Response(null, { status: 503 }) })
await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve))
after(() => new Promise<void>(resolve => listener.close(() => resolve())))
const address = listener.address()
assert.ok(address && typeof address === "object")
const apiUrl = `http://127.0.0.1:${address.port}`

after(stubPublicModelCatalog())
const github = await startFakeGithubGit()
after(() => github.close())
const den = await bootDen({ env: { ...github.env, ...gatewayFixtureEnv, DEN_DEPLOYMENT: "cloud", DEN_API_PUBLIC_URL: apiUrl,
  DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
const transcript: string[] = []
const tokenPattern = /gh[sur]_|occ_task_/
const setupPattern = /occ_setup_/
after(async () => {
  try {
    assert.equal(transcript.some(entry => tokenPattern.test(entry) || setupPattern.test(entry)), false, "no credential outside MCP setupCommand")
    const audit = await den.auditStorageText()
    assert.match(audit, /cloud_coding\.task\.started/)
    assert.equal(tokenPattern.test(audit) || setupPattern.test(audit), false, "no credential in audit storage")
  } finally {
    await den.close()
  }
})
serveDen = request => den.app.fetch(request)
const { db } = await import("../../src/db.js")
const { mintHeadlessTurnCredentials } = await import("../../src/headless-runner/resume-grants.js")
const { setCloudCodingTurnReaderForTests } = await import("../../src/cloud-coding/gateway/turn.js")

const fullName = "acme/storefront"
const totalBefore = "export function checkoutTotal(cents, taxRate) {\n  return Math.floor(cents * (1 + taxRate))\n}\n"
const totalAfter = totalBefore.replace("Math.floor", "Math.round")
const baseSha = await github.seedRepository(fullName, {
  "README.md": "# Storefront\n\nRun `node --test`.\n",
  "package.json": `${JSON.stringify({ name: "storefront", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/total.js": totalBefore,
  "test/total.test.js": "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { checkoutTotal } from '../src/total.js'\ntest('rounds fractional cents', () => assert.equal(checkoutTotal(10, 0.25), 13))\n",
  ".gitignore": "node_modules/\n.env\n.env.*\n",
})
github.addRepository({ id: 11, full_name: fullName, default_branch: "main", private: true, archived: false })
github.addInstallation({ id: 51, account: { id: 71, login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null, html_url: `${github.url}/settings/installations/51`, repositoryIds: [11] })
github.addUser({ id: 1, login: "maya-chen", name: "Maya Chen", installationIds: [51], writableRepositoryIds: [11] })

const maya = await den.createOrg(await den.signUp("Maya Chen", "maya@acme.dev"), "Acme Corp")
const organizationId = normalizeDenTypeId("organization", maya.orgId)
const asMaya = den.as(maya.owner, maya.orgId)
const mayaAgent = await den.mintMcpToken(maya.owner, maya.orgId)
const root = "/v1/cloud-coding"
const gateway = `${root}/gateway`
const taskPrompt = "Fix the one-cent rounding bug in the checkout total."
const title = "Fix one-cent rounding in checkout total"
const description = "Round the checkout total to the nearest cent instead of always rounding down."
const testReport = { status: "passed", command: "node --test --test-reporter=tap", summary: "1 passed" } as const
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const taskIdWhere = (taskId: string) => eq(Tasks.id, normalizeDenTypeId("cloudCodingTask", taskId))

function ok(result: Call, code = 200) {
  assert.equal(result.status, code, summary(result))
  return result.body
}

function refuses(result: Call, code: number, error: string) {
  assert.equal(field(ok(result, code), "error"), error, summary(result))
}

ok(await den.setFeature(maya.orgId, "cloudCoding", true))
const install = new URL(text(field(ok(await asMaya("POST", `${root}/github/install/start`, {})), "redirectUrl"), "GitHub install URL"))
assert.equal(install.pathname, "/apps/acme-cloud-coding/installations/new")
const connected = await asMaya("POST", `${root}/github/callback`, { state: install.searchParams.get("state"), code: github.issueCode(1), installationId: 51 })
assert.equal(field(ok(connected), "outcome"), "connected")
const models = await grantGatewayModels(den, maya.owner, maya.orgId, [maya.owner])

function mintTurn(sessionId: string, messageId: string) {
  return mintHeadlessTurnCredentials({ organizationId, userId: maya.owner.userId, memberId: maya.owner.memberId, sessionId, messageId,
    model: models["gpt-6-luna"], indexKind: "workbot" })
}

const workerId = createDenTypeId("worker")
const workerSecret = randomUUID()
await db.insert(WorkerTable).values({ id: workerId, org_id: organizationId, created_by_user_id: normalizeDenTypeId("user", maya.owner.userId),
  destination: "cloud", name: "Maya's Web computer", status: "healthy" })
await db.insert(WorkerTokenTable).values({ id: createDenTypeId("workerToken"), worker_id: workerId, scope: "activity", token: workerSecret })
const webProof = {
  [CLOUD_CODING_WORKER_ID_HEADER]: workerId,
  [CLOUD_CODING_WORKER_PROOF_HEADER]: `v1.${createHmac("sha256", workerSecret).update(cloudCodingWorkerProofMessage(workerId, sha(mayaAgent))).digest("hex")}`,
}

type Caller = { token: string; proof?: Record<string, string>; originSessionId?: string }
const web = (originSessionId: string): Caller => ({ token: mayaAgent, proof: webProof, originSessionId })
const setupCode = (command: string) => text(/--code "(occ_setup_[A-Za-z0-9_-]+)"/.exec(command)?.[1], "setup code")
const jsonObject = z.record(z.string(), z.unknown())

function withoutSetupCode(value: unknown, allowSetup: boolean) {
  const result = jsonObject.safeParse(value)
  if (!allowSetup || !result.success || typeof result.data.setupCommand !== "string") return value
  const { setupCommand, ...other } = result.data
  return { ...other, setupCommand: setupCommand.replace(setupCode(setupCommand), "[setup code]") }
}

async function mcp(caller: Caller, name: string, args: object) {
  const response = await den.request(caller.token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream", ...caller.proof },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  })
  const body = ok(response)
  const line = response.text.split("\n").find(entry => entry.startsWith("data:"))
  const envelope = jsonObject.parse(line ? JSON.parse(line.slice(5)) : body)
  const result = jsonObject.parse(envelope.result)
  const content = z.array(jsonObject).parse(result.content)
  const allowSetup = name === "execute_capability" && field(args, "name") === "cloud-coding:start" && result.isError !== true
  const { content: _content, structuredContent, ...metadata } = result
  transcript.push(JSON.stringify({ ...envelope, result: { ...metadata, structuredContent: withoutSetupCode(structuredContent, allowSetup), content: content.map(part => {
    if (part.type !== "text" || typeof part.text !== "string") return part
    const parsed = z.string().transform((value, ctx): unknown => {
      try { return JSON.parse(value) } catch {
        ctx.addIssue({ code: "custom", message: "Expected JSON MCP result" })
        return z.NEVER
      }
    }).safeParse(part.text)
    return parsed.success ? { ...part, text: withoutSetupCode(parsed.data, allowSetup) } : part
  }) } }))
  assert.equal(envelope.error, undefined)
  const agentBody: unknown = JSON.parse(text(content.find(part => part.type === "text")?.text, "MCP tool result"))
  return agentBody
}

const execute = (caller: Caller, action: string, args: object) => mcp(caller, "execute_capability", { name: `cloud-coding:${action}`, arguments: args })
const start = (caller: Caller, taskId?: string) => execute(caller, "start", { repository: fullName, task: taskPrompt,
  ...(caller.originSessionId === undefined ? {} : { originSessionId: caller.originSessionId }), ...(taskId === undefined ? {} : { taskId }) })
const startedSchema = z.object({ ok: z.literal(true), taskId: z.string(), repository: z.literal(fullName), baseBranch: z.literal("main"), status: z.literal("ready"),
  workFolder: z.string(), setupCommand: z.string(), instructions: z.string(), expiresInMinutes: z.literal(60) })
async function ready(caller: Caller, rootPrefix: string, taskId?: string) {
  const body = await start(caller, taskId)
  assert.equal(field(body, "sessionId"), undefined)
  const task = startedSchema.parse(body)
  const taskRoot = `${rootPrefix}/${task.taskId}`
  assert.equal(task.workFolder, `${taskRoot}/storefront`)
  assert.ok(task.setupCommand.startsWith(`mkdir -p "${taskRoot}" && curl -fsSL "${apiUrl}${gateway}/helper.mjs"`))
  assert.ok(task.setupCommand.endsWith(`--root "${taskRoot}"`))
  return { ...task, taskRoot }
}
type ReadyTask = Awaited<ReturnType<typeof ready>>
const webRoot = (originSessionId: string) => `/tmp/openwork-cloud-coding/${sha(originSessionId).slice(0, 16)}`

async function absent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" })
}

type Run = { code: number; output: string }
function run(command: string, args: string[], cwd: string, home: string): Promise<Run> {
  return new Promise(resolve => {
    execFile(command, args, {
      cwd, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8", timeout: 120_000,
    }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0
      const output = `${stdout}${stderr}`
      transcript.push(output)
      resolve({ code, output })
    })
  })
}

async function chatComputerWithAbsoluteRootsMappedIntoATempDirectory(t: TestContext) {
  const computer = await mkdtemp(join(await realpath(tmpdir()), "cloud-coding-computer-"))
  t.after(async () => {
    await rm(computer, { recursive: true, force: true })
    await absent(computer)
  })
  const home = join(computer, "home")
  await mkdir(home)
  const onComputer = (command: string, args: string[], cwd = computer) => run(command, args, cwd, home)
  const localize = (value: string) => value.replaceAll("/workspace/cloud-coding/", `${computer}/workspace/cloud-coding/`)
    .replaceAll("/tmp/openwork-cloud-coding/", `${computer}/tmp/openwork-cloud-coding/`)
  return {
    async setup(task: ReadyTask) {
      const setup = await onComputer("sh", ["-c", localize(task.setupCommand)])
      assert.equal(setup.code, 0, setup.output)
      assert.match(setup.output, /npm test|node --test/)
      assert.deepEqual(await readdir(home), [], "setup writes nothing under HOME")
      const taskRoot = localize(task.taskRoot)
      const checkout = localize(task.workFolder)
      const state = z.object({ token: z.string().startsWith("occ_task_") }).parse(JSON.parse(await readFile(join(taskRoot, "state.json"), "utf8")))
      return { taskRoot, checkout, token: state.token,
        shell: (command: string, args: string[]) => onComputer(command, args, checkout),
        helper: (action: string, args: string[] = []) => onComputer(process.execPath, [join(taskRoot, "openwork-code.mjs"), action, "--root", taskRoot, ...args]),
      }
    },
  }
}
type Checkout = Awaited<ReturnType<Awaited<ReturnType<typeof chatComputerWithAbsoluteRootsMappedIntoATempDirectory>>["setup"]>>

const taskView = (token: string) => den.request(token, "GET", `${gateway}/task`)
const approvalRoute = (id: string) => `${root}/approvals/${id}`
const readApproval = async (id: string) => cloudCodingPushApprovalSchema.parse(ok(await asMaya("GET", approvalRoute(id))))
const decide = (id: string, decision: "allow_once" | "deny" = "allow_once") => asMaya("POST", `${approvalRoute(id)}/decision`, { decision })
const taskRows = () => db.$primary.select().from(Tasks)
const approvalRows = () => db.$primary.select().from(Approvals)

async function editAndRequest(checkout: Checkout, taskId: string, branch: string, contents = totalAfter) {
  await writeFile(join(checkout.checkout, "src/total.js"), contents)
  await writeFile(join(checkout.checkout, ".env"), "SECRET=not-for-github\n")
  await writeFile(join(checkout.checkout, ".env.local"), "SECRET=also-not-for-github\n")
  const tested = await checkout.shell(process.execPath, ["--test", "--test-reporter=tap"])
  assert.equal(tested.code, 0, tested.output)
  assert.match(tested.output, /# pass 1\b/)
  const bodyFile = join(checkout.taskRoot, "pull-request.md")
  await writeFile(bodyFile, description)
  const requested = await checkout.helper("request-push", ["--branch", branch, "--title", title,
    "--body-file", bodyFile, "--tests", testReport.status,
    "--test-command", testReport.command, "--test-summary", testReport.summary, "--wait-seconds", "1"])
  assert.equal(requested.code, 3, requested.output)
  assert.match(requested.output, /Still waiting for approval/)
  const { approvals } = cloudCodingPushApprovalListSchema.parse(ok(await asMaya("GET", `${root}/approvals?status=pending`)))
  assert.equal(approvals.length, 1)
  const [approval] = approvals
  assert.ok(approval)
  assert.equal(approval.taskId, taskId)
  assert.equal(approval.repositoryFullName, fullName)
  assert.equal(approval.branch, branch)
  assert.deepEqual(approval.files, [{ path: "src/total.js", change: "modified" }])
  assert.deepEqual(approval.tests, testReport)
  return approval
}

async function assertNoPush(branch: string, writesBefore: number) {
  assert.deepEqual(github.writes.slice(writesBefore), [], "nothing is written to GitHub")
  assert.equal(await github.readBranch(fullName, branch), null)
  assert.equal(github.pulls.get(fullName)?.some(pull => pull.head.ref === branch) ?? false, false)
}

async function assertOpened(checkout: Checkout, approval: CloudCodingPushApproval, caller: Caller, writesBefore: number) {
  const finished = await checkout.helper("wait", ["--wait-seconds", "5"])
  assert.equal(finished.code, 0, finished.output)
  const link = /Pull request opened: (\S+)/.exec(finished.output)?.[1]
  assert.ok(link, finished.output)
  const branch = await github.readBranch(fullName, approval.branch)
  assert.ok(branch)
  assert.equal(branch.sha, approval.headSha, "the pushed commit is the approved commit")
  assert.equal(branch.parent, baseSha)
  assert.match(branch.author ?? "", /^Maya Chen <1\+maya-chen@users\.noreply\.github\.com> /)
  assert.equal(branch.committer, branch.author)
  assert.equal(branch.files.find(file => file.path === "src/total.js")?.contents.toString(), totalAfter)
  assert.equal(branch.files.some(file => file.path.startsWith(".env")), false, "ignored files stay on the cloud computer")
  assert.equal((await github.readBranch(fullName, "main"))?.sha, baseSha)
  const writes = github.writes.slice(writesBefore)
  assert.ok(writes.length > 0)
  assert.ok(writes.every(write => write.kind === "user"), "every write used the person's own token")
  assert.equal(writes.filter(write => write.path.endsWith("/git/refs")).length, 1)
  const pulls = github.pulls.get(fullName)?.filter(pull => pull.head.ref === approval.branch)
  assert.deepEqual(pulls?.map(pull => ({ url: pull.html_url, user: pull.user.login, head: pull.head.sha, base: pull.base.ref, body: pull.body })),
    [{ url: link, user: "maya-chen", head: approval.headSha, base: "main", body: description }])

  const overview = cloudCodingOverviewSchema.parse(ok(await asMaya("GET", root)))
  const pull = overview.pullRequests.find(pull => pull.url === link)
  assert.deepEqual({ title: pull?.title, state: pull?.state, by: pull?.openedBy.name }, { title, state: "open", by: "Maya Chen" })
  const status = await execute(caller, "status", { taskId: approval.taskId })
  assert.equal(field(status, "pullRequest", "url"), link)
  assert.equal((await readApproval(approval.id)).pullRequest?.url, link)
  await absent(checkout.taskRoot)
  refuses(await taskView(checkout.token), 401, "task_closed")
  const [row] = await taskRows().where(taskIdWhere(approval.taskId))
  assert.equal(row?.tokenHash, null, "the helper released the credential")
}

test("in a Workbot conversation the change is made on the conversation's own computer and the pull request opens in the person's name", async t => {
  const computer = await chatComputerWithAbsoluteRootsMappedIntoATempDirectory(t)
  const writesBefore = github.writes.length
  const conversation = "ses_storefront_workbot"
  const first = await mintTurn(conversation, "msg_fix_rounding")
  const firstMessage = "msg_fix_rounding"
  t.after(() => setCloudCodingTurnReaderForTests())
  setCloudCodingTurnReaderForTests(async () => [{ messageId: firstMessage, status: "running" }])

  const started = await ready(first, "/workspace/cloud-coding")
  const [row] = await taskRows().where(taskIdWhere(started.taskId))
  assert.equal(row?.surface, "workbot")
  assert.equal(row?.conversationId, conversation)
  assert.equal(row?.runTokenId, first.tokenId)
  assert.equal(row?.runnerMessageId, firstMessage)
  const checkout = await computer.setup(started)
  assert.equal(await readFile(join(checkout.checkout, "src/total.js"), "utf8"), totalBefore)
  const config = await readFile(join(checkout.checkout, ".git/config"), "utf8")
  assert.equal(/gh[sur]_|occ_(?:task|setup)_|x-access-token|extraheader|http:\/\/[^/]+@/i.test(config), false, "no credential is left in the clone")
  const directPush = await checkout.shell("git", ["push", "origin", "HEAD:refs/heads/openwork/direct"])
  assert.notEqual(directPush.code, 0, "the cloud computer cannot push with git")
  await assertNoPush("openwork/direct", writesBefore)

  const approval = await editAndRequest(checkout, started.taskId, "openwork/workbot-rounding")
  await assertNoPush(approval.branch, writesBefore)
  setCloudCodingTurnReaderForTests(async () => [{ messageId: firstMessage, status: "completed" }])
  const ended = await checkout.helper("status")
  assert.equal(ended.code, 6, ended.output)
  assert.ok(ended.output.includes(`Call cloud-coding:start again with taskId ${started.taskId}`), ended.output)
  const oldView = await taskView(checkout.token)
  refuses(oldView, 401, "task_closed")
  assert.equal(field(oldView.body, "message"), "This credential ended with the turn. Call cloud-coding:start again with this taskId to continue.")

  for (const token of [mayaAgent, first.token]) {
    const result = await den.request(token, "POST", `${approvalRoute(approval.id)}/decision`, { orgId: maya.orgId, body: { decision: "allow_once" } })
    assert.ok([401, 403].includes(result.status), summary(result))
  }
  assert.equal((await readApproval(approval.id)).status, "pending")
  assert.equal(cloudCodingPushApprovalSchema.parse(ok(await decide(approval.id))).status, "approved")
  await assertNoPush(approval.branch, writesBefore)

  const other = await mintTurn("ses_other_workbot", "msg_other")
  const nextMessage = "msg_resume_rounding"
  const next = await mintTurn(conversation, nextMessage)
  assert.notEqual(next.tokenId, first.tokenId)
  setCloudCodingTurnReaderForTests(async () => [{ messageId: nextMessage, status: "running" }, { messageId: "msg_other", status: "running" }])
  const tasksBefore = (await taskRows()).length
  const approvalsBefore = (await approvalRows()).length
  assert.equal(field(await start(other, started.taskId), "error"), "task_closed")
  assert.equal((await taskRows()).length, tasksBefore)
  assert.equal((await approvalRows()).length, approvalsBefore)

  const renewed = await ready(next, "/workspace/cloud-coding", started.taskId)
  assert.equal(renewed.taskId, started.taskId)
  assert.equal(renewed.workFolder, started.workFolder)
  assert.notEqual(sha(renewed.setupCommand), sha(started.setupCommand))
  const resumed = await computer.setup(renewed)
  assert.equal(resumed.checkout, checkout.checkout)
  assert.equal(await readFile(join(resumed.checkout, "src/total.js"), "utf8"), totalAfter)
  assert.notEqual(sha(resumed.token), sha(checkout.token))
  await assertOpened(resumed, approval, next, writesBefore)
  assert.equal(field(await start(other, started.taskId), "error"), "task_closed")
  assert.equal((await taskRows()).length, tasksBefore)
  assert.equal((await approvalRows()).length, approvalsBefore)
})

test("in an OpenWork Web chat the change is made on the chat's own cloud computer", async t => {
  const computer = await chatComputerWithAbsoluteRootsMappedIntoATempDirectory(t)
  const writesBefore = github.writes.length
  const originSessionId = "ses_storefront_web"
  const caller = web(originSessionId)
  const started = await ready(caller, webRoot(originSessionId))
  const [row] = await taskRows().where(taskIdWhere(started.taskId))
  assert.equal(row?.surface, "web")
  assert.equal(row?.conversationId, originSessionId)
  assert.equal(row?.workerId, workerId)
  assert.equal(row?.runTokenId, null)
  const checkout = await computer.setup(started)
  assert.equal(await readFile(join(checkout.checkout, "src/total.js"), "utf8"), totalBefore)
  const branch = "openwork/web-rounding"
  const first = await editAndRequest(checkout, started.taskId, branch, `${totalAfter}\n`)
  await assertNoPush(branch, writesBefore)
  const replacement = await editAndRequest(checkout, started.taskId, branch)
  assert.notEqual(replacement.id, first.id)
  assert.notEqual(replacement.headSha, first.headSha)
  assert.equal((await readApproval(first.id)).status, "superseded")
  refuses(await decide(first.id), 409, "approval_not_pending")
  await assertNoPush(branch, writesBefore)
  assert.equal(cloudCodingPushApprovalSchema.parse(ok(await decide(replacement.id))).status, "approved")
  await assertOpened(checkout, replacement, caller, writesBefore)
})

test("a denied push leaves nothing on the computer or on GitHub", async t => {
  const computer = await chatComputerWithAbsoluteRootsMappedIntoATempDirectory(t)
  const writesBefore = github.writes.length
  const originSessionId = "ses_denied_web"
  const started = await ready(web(originSessionId), webRoot(originSessionId))
  const checkout = await computer.setup(started)
  const approval = await editAndRequest(checkout, started.taskId, "openwork/denied-rounding")
  assert.equal(cloudCodingPushApprovalSchema.parse(ok(await decide(approval.id, "deny"))).status, "denied")
  const finished = await checkout.helper("wait", ["--wait-seconds", "5"])
  assert.equal(finished.code, 4, finished.output)
  assert.match(finished.output, /The push was denied\. Nothing was pushed\./)
  await absent(checkout.taskRoot)
  refuses(await taskView(checkout.token), 401, "task_closed")
  const [row] = await taskRows().where(taskIdWhere(started.taskId))
  assert.equal(row?.status, "cancelled")
  assert.equal(row?.failureCode, "push_denied")
  assert.equal(row?.tokenHash, null)
  await assertNoPush(approval.branch, writesBefore)
})

test("a credential stops working when it expires, and approvals cannot be used twice", async t => {
  const computer = await chatComputerWithAbsoluteRootsMappedIntoATempDirectory(t)
  const writesBefore = github.writes.length
  const originSessionId = "ses_expiry_web"
  const caller = web(originSessionId)
  const started = await ready(caller, webRoot(originSessionId))
  const checkout = await computer.setup(started)
  ok(await taskView(checkout.token))
  await db.update(Tasks).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(taskIdWhere(started.taskId))
  const expired = await checkout.helper("status")
  assert.equal(expired.code, 6, expired.output)
  refuses(await taskView(checkout.token), 401, "task_closed")

  const replacement = await ready(caller, webRoot(originSessionId), started.taskId)
  const code = setupCode(replacement.setupCommand)
  await db.update(Tasks).set({ setupCodeExpiresAt: new Date(Date.now() - 1000) }).where(taskIdWhere(started.taskId))
  refuses(await den.request(null, "POST", `${gateway}/setup`, { body: { code } }), 401, "task_closed")
  const branch = "openwork/single-use-rounding"
  await assertNoPush(branch, writesBefore)

  const renewed = await ready(caller, webRoot(originSessionId), started.taskId)
  const resumed = await computer.setup(renewed)
  const approval = await editAndRequest(resumed, started.taskId, branch)
  assert.equal(cloudCodingPushApprovalSchema.parse(ok(await decide(approval.id))).status, "approved")
  refuses(await decide(approval.id), 409, "approval_not_pending")
  await assertOpened(resumed, approval, caller, writesBefore)
  const writesAfter = github.writes.slice()
  const pullsAfter = github.pulls.get(fullName)?.length
  const changeSet = { branch, baseSha, commitMessage: `${title}\n`, files: [{ path: "src/total.js", mode: "100644", contentBase64: Buffer.from(totalAfter).toString("base64") }] }
  refuses(await den.request(resumed.token, "POST", `${gateway}/push-approvals/${approval.id}/push`, { body: { changeSet } }), 401, "task_closed")
  assert.deepEqual(github.writes, writesAfter)
  assert.equal(github.pulls.get(fullName)?.length, pullsAfter)
  assert.equal((await github.readBranch(fullName, branch))?.sha, approval.headSha)
})

test("the desktop app gets no cloud coding", async () => {
  const desktop = { token: mayaAgent }
  const writesBefore = github.writes.length
  const tasksBefore = (await taskRows()).length
  const approvalsBefore = (await approvalRows()).length
  const found = await mcp(desktop, "search_capabilities", { query: "fix a bug in the storefront repo and open a pull request" })
  const matches = z.array(z.object({ name: z.string() })).parse(field(found, "matches"))
  assert.equal(matches.some(match => match.name.startsWith("cloud-coding:")), false)
  assert.equal(field(await start(desktop), "error"), "unknown_capability")
  assert.equal((await taskRows()).length, tasksBefore)
  assert.equal((await approvalRows()).length, approvalsBefore)
  assert.equal(github.writes.length, writesBefore)
})
