import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import { createAdaptorServer } from "@hono/node-server"
import { cloudCodingOverviewSchema, cloudCodingPushApprovalListSchema, cloudCodingPushApprovalSchema } from "@openwork/types/den/cloud-coding"
import { z } from "zod"
import { startFakeGithubGit } from "./cloud-coding-fake-github-git.js"
import { bootDen, field, summary, type Call } from "./harness.js"

let serveDen: ((request: Request) => Response | Promise<Response>) | undefined
const listener = createAdaptorServer({ fetch: (request) => serveDen ? serveDen(request) : new Response(null, { status: 503 }) })
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
after(() => new Promise<void>((resolve) => listener.close(() => resolve())))
const address = listener.address()
assert.ok(address && typeof address === "object")
const apiUrl = `http://127.0.0.1:${(address satisfies AddressInfo).port}`

const github = await startFakeGithubGit()
after(() => github.close())
const den = await bootDen({ env: { ...github.env, DEN_DEPLOYMENT: "cloud", DEN_API_PUBLIC_URL: apiUrl } })
after(() => den.close())
serveDen = (request) => den.app.fetch(request)
const { setCloudCodingSessionStarterForTests } = await import("../../src/cloud-coding/mcp/capabilities.js")
after(() => setCloudCodingSessionStarterForTests(undefined))

const fullName = "acme/storefront"
const totalBefore = "export function checkoutTotal(cents, taxRate) {\n  return Math.floor(cents * (1 + taxRate))\n}\n"
const totalAfter = "export function checkoutTotal(cents, taxRate) {\n  return Math.round(cents * (1 + taxRate))\n}\n"
const baseSha = await github.seedRepository(fullName, {
  "README.md": "# Storefront\n\nRun `npm test`.\n",
  "package.json": `${JSON.stringify({ name: "storefront", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/total.js": totalBefore,
  ".gitignore": "node_modules/\n.env\n",
})
github.addRepository({ id: 11, full_name: fullName, default_branch: "main", private: true, archived: false })
github.addInstallation({ id: 51, account: { id: 71, login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null, html_url: `${github.url}/settings/installations/51`, repositoryIds: [11] })
github.addUser({ id: 1, login: "maya-chen", name: "Maya Chen", installationIds: [51], writableRepositoryIds: [11] })

const maya = await den.createOrg(await den.signUp("Maya Chen", "maya@acme.dev"), "Acme Corp")
const asMaya = den.as(maya.owner, maya.orgId)
const mayaAgent = await den.mintMcpToken(maya.owner, maya.orgId)
const root = "/v1/cloud-coding"

function ok(result: Call, code = 200) {
  assert.equal(result.status, code, summary(result))
  return result.body
}

type Run = { code: number; output: string }
function run(command: string, args: string[], options: { cwd: string; home: string }): Promise<Run> {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: options.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      timeout: 120_000,
    }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0
      resolve({ code, output: `${stdout}${stderr}` })
    })
  })
}

test("a person asks for a code change, approves the push, and the pull request opens in their name", async (t) => {
  const computer = await mkdtemp(join(tmpdir(), "cloud-coding-computer-"))
  t.after(() => rm(computer, { recursive: true, force: true }))
  const home = join(computer, "home")
  const work = join(computer, "work")
  await mkdir(home)
  await mkdir(work)
  const helper = join(home, ".openwork/cloud-coding/openwork-code.mjs")
  const transcript: string[] = []
  const onComputer = async (command: string, args: string[], cwd = work) => {
    const result = await run(command, args, { cwd, home })
    transcript.push(result.output)
    return result
  }

  ok(await den.setFeature(maya.orgId, "cloudCoding", true))

  const kickoffs: string[] = []
  setCloudCodingSessionStarterForTests(async (input) => {
    kickoffs.push(z.object({ prompt: z.string() }).parse(input.body).prompt)
    const receipt = { sessionId: "ses_storefront", workspaceId: "workspace_storefront", workerId: "worker_storefront", started: true }
    return { isError: false, structuredContent: receipt, content: [{ type: "text" as const, text: JSON.stringify(receipt) }] }
  })
  const start = () => den.callMcpTool(mayaAgent, "execute_capability", { name: "cloud-coding:start", arguments: { repository: fullName, task: "Fix the one-cent rounding bug in the checkout total." } })

  const beforeConnect = await start()
  assert.equal(field(beforeConnect.body, "error"), "github_not_connected")
  assert.equal(field(beforeConnect.body, "connectionStatus", "actor"), "organization_admin")

  const install = new URL(z.string().parse(field(ok(await asMaya("POST", `${root}/github/install/start`, {})), "redirectUrl")))
  assert.equal(install.pathname, "/apps/acme-cloud-coding/installations/new")
  const connected = await asMaya("POST", `${root}/github/callback`, { state: install.searchParams.get("state"), code: github.issueCode(1), installationId: 51 })
  assert.equal(field(ok(connected), "outcome"), "connected")

  const started = await start()
  assert.equal(started.isError, false, started.raw)
  const taskId = z.string().parse(field(started.body, "taskId"))
  assert.equal(kickoffs.length, 1)
  const setupCommand = (kickoffs[0] ?? "").split("\n").find((line) => line.startsWith("mkdir -p ~/.openwork/cloud-coding"))
  assert.ok(setupCommand, "the kickoff carries the setup command")
  assert.ok(setupCommand.includes(`${apiUrl}/v1/cloud-coding/gateway/helper.mjs`))

  const setup = await onComputer("sh", ["-c", setupCommand])
  assert.equal(setup.code, 0, setup.output)
  const checkout = join(work, "storefront")
  assert.equal(await readFile(join(checkout, "src/total.js"), "utf8"), totalBefore)
  assert.match(setup.output, /npm test|node --test/)
  const config = await readFile(join(checkout, ".git/config"), "utf8")
  assert.equal(/ghs_|ghu_|x-access-token|extraheader/i.test(config), false, "no credential is left in the clone")

  await writeFile(join(checkout, "src/total.js"), totalAfter)
  await writeFile(join(checkout, ".env"), "SECRET=not-for-github\n")
  await writeFile(join(home, ".openwork/cloud-coding/pull-request.md"), "Round the checkout total to the nearest cent instead of always rounding down.\n")
  const directPush = await onComputer("git", ["push", "origin", "HEAD:refs/heads/openwork/direct"], checkout)
  assert.notEqual(directPush.code, 0, "the cloud computer cannot push with git")

  const pushArgs = [helper, "request-push", "--task", taskId, "--branch", "openwork/fix-rounding", "--title", "Fix one-cent rounding in checkout total",
    "--body-file", join(home, ".openwork/cloud-coding/pull-request.md"), "--tests", "passed", "--test-command", "npm test", "--test-summary", "1 passed", "--wait-seconds", "1"]
  const requested = await onComputer(process.execPath, pushArgs, checkout)
  assert.equal(requested.code, 3, requested.output)

  const pending = cloudCodingPushApprovalListSchema.parse(ok(await asMaya("GET", `${root}/approvals?status=pending`))).approvals
  assert.equal(pending.length, 1)
  const [approval] = pending
  assert.ok(approval)
  assert.equal(approval.repositoryFullName, fullName)
  assert.equal(approval.branch, "openwork/fix-rounding")
  assert.deepEqual(approval.files, [{ path: "src/total.js", change: "modified" }])
  assert.deepEqual(approval.tests, { status: "passed", command: "npm test", summary: "1 passed" })
  assert.deepEqual(github.writes, [], "nothing reaches GitHub before the person allows it")
  assert.equal(await github.readBranch(fullName, "openwork/fix-rounding"), null)

  const agentDecision = await den.request(mayaAgent, "POST", `${root}/approvals/${approval.id}/decision`, { orgId: maya.orgId, body: { decision: "allow_once" } })
  assert.notEqual(agentDecision.status, 200, "an agent token cannot approve the push")
  assert.equal(cloudCodingPushApprovalSchema.parse(ok(await asMaya("POST", `${root}/approvals/${approval.id}/decision`, { decision: "allow_once" }))).status, "approved")

  const finished = await onComputer(process.execPath, [helper, "wait", "--task", taskId], checkout)
  assert.equal(finished.code, 0, finished.output)
  const link = /Pull request opened: (\S+)/.exec(finished.output)?.[1]
  assert.ok(link, finished.output)

  const branch = await github.readBranch(fullName, "openwork/fix-rounding")
  assert.ok(branch)
  assert.equal(branch.sha, approval.headSha, "the pushed commit is the approved commit")
  assert.equal(branch.parent, baseSha)
  assert.match(branch.author ?? "", /^Maya Chen <1\+maya-chen@users\.noreply\.github\.com> /)
  assert.equal(branch.committer, branch.author)
  assert.equal(branch.files.find((file) => file.path === "src/total.js")?.contents.toString(), totalAfter)
  assert.equal(branch.files.some((file) => file.path === ".env"), false, "ignored files stay on the cloud computer")
  const main = await github.readBranch(fullName, "main")
  assert.equal(main?.sha, baseSha, "the default branch is untouched")
  assert.ok(github.writes.length > 0)
  assert.ok(github.writes.every((write) => write.kind === "user"), "every write used the person's own token")
  assert.equal(github.pulls.get(fullName)?.[0]?.user.login, "maya-chen")

  const overview = cloudCodingOverviewSchema.parse(ok(await asMaya("GET", root)))
  assert.deepEqual(overview.pullRequests.map((pull) => ({ url: pull.url, title: pull.title, state: pull.state, by: pull.openedBy.name })),
    [{ url: link, title: "Fix one-cent rounding in checkout total", state: "open", by: "Maya Chen" }])
  const status = await den.callMcpTool(mayaAgent, "execute_capability", { name: "cloud-coding:status", arguments: { taskId } })
  assert.equal(field(status.body, "pullRequest", "url"), link)
  assert.equal(cloudCodingPushApprovalSchema.parse(ok(await asMaya("GET", `${root}/approvals/${approval.id}`))).pullRequest?.url, link)

  const everything = [...transcript, started.raw, status.raw].join("\n")
  assert.equal(/gh[sur]_[A-Za-z0-9-]{8,}|occ_task_/.test(everything), false, "no token is printed or returned to the agent")
})
