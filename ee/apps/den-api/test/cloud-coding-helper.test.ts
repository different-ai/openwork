import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { once } from "node:events"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { pathToFileURL } from "node:url"
import {
  cloudCodingGatewaySetupInputSchema, cloudCodingOpenPullRequestInputSchema, cloudCodingPushInputSchema, cloudCodingPushRequestSchema,
  type CloudCodingPushApprovalStatus,
} from "@openwork/types/den/cloud-coding"
import { OPENWORK_CODE_HELPER_SOURCE } from "../src/cloud-coding/helper/openwork-code-source.js"

const prefix = "/v1/cloud-coding/gateway"
const code = "fixture-setup-code-one-time"
const token = "fixture-den-task-token"
const resumeCode = "fixture-resume-code"
const otherCode = "fixture-other-code"
const resumedToken = "fixture-renewed-den-token"
const cleanupLine = "Removed the working folder and its credential from this computer.\n"
const readToken = "fixture-github-read-token"
const basic = Buffer.from(`x-access-token:${readToken}`).toString("base64")
const taskId = "cctask_storefront"
const author = { name: "Maya Chen", login: "maya-chen", email: "maya-chen@users.noreply.github.com" }
const repoName = "acme/storefront"
const prUrl = `https://github.com/${repoName}/pull/17`
const expires = "2030-01-01T00:00:00.000Z"
const binary = Buffer.from([0, 10, 255, 253, 1, 0])

function write(dir: string, file: string, data: string | Buffer) {
  const dest = path.join(dir, file)
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, data)
}

function noSecrets(output: string) {
  for (const secret of [code, resumeCode, otherCode, token, resumedToken, readToken, basic]) assert.equal(output.includes(secret), false, "output contained a credential")
}

function workspace(t: TestContext, cap?: number) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openwork-code-test-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, "home")
  mkdirSync(home)
  const taskRoot = path.join(root, "coding task")
  mkdirSync(taskRoot)
  const script = path.join(taskRoot, "openwork-code.mjs")
  writeFileSync(script, OPENWORK_CODE_HELPER_SOURCE)
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", OPENWORK_CODE_TEST_MAX_WAIT_MS: cap?.toString() }

  function run(...args: string[]) { return runFrom(root, ...args) }

  function runFrom(cwd: string, ...args: string[]) {
    const useRoot = !args.some((arg) => ["--root", "--dir", "--help"].includes(arg))
    if (useRoot) args.push("--root", taskRoot)
    return new Promise<{ exit: number | string | null; output: string }>((resolve, reject) => {
      execFile(process.execPath, [script, ...args], { cwd, env, timeout: 12_000 }, (error, stdout, stderr) => {
        try {
          noSecrets(stdout + stderr)
          assert.equal(stderr, "")
          resolve({ exit: error ? error.code ?? null : 0, output: stdout })
        } catch (err) { reject(err) }
      })
    })
  }

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  return { root, home, taskRoot, script, run, runFrom, git }
}

function seed(root: string, git: ReturnType<typeof workspace>["git"]) {
  const dir = path.join(root, "seed")
  mkdirSync(dir)
  git(dir, "init", "-b", "main", "--object-format=sha1")
  write(dir, "README.md", "# Acme Storefront\n\n## Getting started\n\n## Testing\n")
  write(dir, "package.json", JSON.stringify({ packageManager: "pnpm@11.0.0", scripts: { test: "node --test", lint: "eslint .", typecheck: "tsc" } }))
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  write(dir, "src/checkout/total.ts", "export const total = 0\n")
  write(dir, "scripts/build.sh", "#!/bin/sh\nprintf 'Build\\n'\n")
  chmodSync(path.join(dir, "scripts/build.sh"), 0o755)
  write(dir, ".gitignore", "node_modules/\n.env\n")
  write(dir, ".github/workflows/ci.yml", "steps:\n  - run: pnpm test\n  - run: |\n      pnpm install --frozen-lockfile\n      pnpm lint\n    name: Acme Storefront\n")
  write(dir, "obsolete.txt", "Obsolete\n")
  git(dir, "add", "-A")
  git(dir, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", "Seed Acme Storefront")
  const bare = path.join(root, "storefront.git")
  git(root, "clone", "--bare", dir, bare)
  return { cloneUrl: pathToFileURL(bare).href, baseSha: git(dir, "rev-parse", "HEAD") }
}

async function stubGateway(t: TestContext, cloneUrl: string) {
  const task = { taskId, repository: { fullName: repoName, cloneUrl, defaultBranch: "main" }, baseBranch: "main", author }
  const recorded: { method: string; endpoint: string; query: string; raw: string; authorization?: string }[] = []
  const requested = new Map<string, ReturnType<typeof cloudCodingPushRequestSchema.parse>>()
  const approvals = new Map<string, { id: string; status: CloudCodingPushApprovalStatus; branch: string; headSha: string; repositoryFullName: string; pullRequest: { number: number; url: string; state: "open" } | null }>()
  let approvalNumber = 0
  const redeemed = new Set<string>()
  let activeToken = token
  let closed = false
  let breakRelease = false
  let failPush = 0
  let failPr = 0
  let interruptedGet = 0
  let mismatch = false
  const server = createServer(async (req, res) => {
    const send = (status: number, body: object) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      const endpoint = url.pathname.slice(prefix.length)
      const method = req.method ?? "GET"
      req.setEncoding("utf8")
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body: unknown = raw ? JSON.parse(raw) : undefined
      recorded.push({ method, endpoint, query: url.search, raw, authorization: req.headers.authorization })
      if (method === "POST" && endpoint === "/setup") {
        assert.equal(req.headers.authorization, undefined)
        const setupCode = cloudCodingGatewaySetupInputSchema.parse(body).code
        if (redeemed.has(setupCode)) return send(403, { error: "task_closed", message: "This setup code has already been used. Ask for a fresh one." })
        redeemed.add(setupCode)
        if (setupCode === otherCode) return send(200, { ...task, taskId: "cctask_other", token: resumedToken, tokenExpiresAt: expires })
        assert.ok(setupCode === code || setupCode === resumeCode)
        activeToken = setupCode === resumeCode ? resumedToken : token
        closed = false
        return send(200, { ...task, token: activeToken, tokenExpiresAt: setupCode === resumeCode ? "2030-01-02T00:00:00.000Z" : expires })
      }
      assert.equal(req.headers.authorization, `Bearer ${activeToken}`, "gateway request did not carry the current task token")
      const denied = [...approvals.values()].some((approval) => approval.status === "denied")
      if (method === "POST" && endpoint === "/release") {
        if (breakRelease) return req.socket.destroy()
        if (denied || closed) return send(401, { error: "task_closed", message: "This task credential is not active." })
        res.writeHead(204)
        return res.end()
      }
      if (closed || (denied && !(method === "GET" && /^\/push-approvals\/[^/]+$/.test(endpoint)))) {
        return send(401, { error: "task_closed", message: `This task credential is not active: ${activeToken}` })
      }
      if (method === "GET" && endpoint === "/task") {
        if (interruptedGet-- > 0) return req.socket.destroy()
        return send(200, task)
      }
      if (method === "POST" && endpoint === "/read-token") return send(200, { token: readToken, expiresAt: expires, cloneUrl })
      if (method === "POST" && endpoint === "/push-approvals") {
        const input = cloudCodingPushRequestSchema.parse(body)
        const id = "approval-" + ++approvalNumber
        if (input.title === "Gateway refusal") return send(403, { error: "turned_off", message: "Cloud coding is off. Ask an Acme Corp admin to turn it on." })
        const approval = { id, status: "pending" as const, branch: input.changeSet.branch, headSha: "1".repeat(40), repositoryFullName: repoName, pullRequest: null }
        approvals.set(id, approval)
        requested.set(id, input)
        return send(201, { approval })
      }
      const match = /^\/push-approvals\/([^/]+)(\/push)?$/.exec(endpoint)
      if (match) {
        const id = match[1]
        const approval = approvals.get(id)
        if (!approval) return send(404, { error: "approval_not_found", message: "The approval was not found. Request it again." })
        if (method === "GET" && !match[2]) return send(200, { approval })
        if (method === "POST" && match[2]) {
          if (failPush-- > 0) return send(503, { error: "github_refused", message: "GitHub is unavailable. Try again." })
          if (mismatch) return send(409, { error: "commit_mismatch", message: "The approved commit did not match." })
          assert.ok(approval.status === "approved" || approval.status === "pushed")
          assert.deepEqual(cloudCodingPushInputSchema.parse(body).changeSet, requested.get(id)?.changeSet)
          approval.status = "pushed"
          return send(200, { approval, branch: approval.branch, headSha: approval.headSha })
        }
      }
      if (method === "POST" && endpoint === "/pull-requests") {
        if (failPr-- > 0) return req.socket.destroy()
        const id = cloudCodingOpenPullRequestInputSchema.parse(body).approvalId
        const approval = approvals.get(id)
        assert.equal(approval?.status, "pushed")
        if (!approval) throw new Error("Approval not found")
        approval.pullRequest = { number: 17, url: prUrl, state: "open" }
        return send(200, { ...approval.pullRequest, title: requested.get(id)?.title, repositoryFullName: repoName, branch: approval.branch })
      }
      send(404, { error: "task_closed", message: "This task is not available. Start a new one." })
    } catch {
      send(500, { error: "stub_error", message: "The test gateway received an unexpected request." })
    }
  })
  server.listen(0, "127.0.0.1")
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return {
    api: `http://127.0.0.1:${address.port}`, recorded,
    decide(status: CloudCodingPushApprovalStatus) {
      const approval = approvals.get("approval-" + approvalNumber)
      assert.ok(approval)
      approval.status = status
      return approval.id
    },
    failOnce() { failPush = failPr = interruptedGet = 1 },
    closeCredential() { closed = true },
    failRelease() { breakRelease = true },
    mismatch() { mismatch = true },
  }
}

async function taskFixture(t: TestContext, cap?: number) {
  const files = workspace(t, cap)
  const bare = seed(files.root, files.git)
  const stub = await stubGateway(t, bare.cloneUrl)
  const dir = path.join(files.taskRoot, "storefront")
  const setup = (setupCode = code, ...args: string[]) => files.run("setup", "--api", stub.api, "--code", setupCode, ...args)
  const request = (title = "Fix checkout rounding", ...args: string[]) => files.run("request-push", "--branch", "openwork/fix-rounding", "--title", title, "--tests", "not_run", ...(args.length ? args : ["--wait-seconds", "0"]))
  const stateFile = path.join(files.taskRoot, "state.json")
  const readState = () => JSON.parse(readFileSync(stateFile, "utf8"))
  const waitCommand = `node ${JSON.stringify(files.script)} wait --root ${JSON.stringify(files.taskRoot)}`
  return { ...files, ...bare, ...stub, dir, setup, request, stateFile, readState, waitCommand }
}

test("approval and push carry byte-identical Git changes from the embedded helper", async (t) => {
  const f = await taskFixture(t)
  execFileSync(process.execPath, ["--check", f.script])
  const setup = await f.setup()
  assert.equal(setup.exit, 0, setup.output)
  assert.ok(setup.output.includes(`Work in: ${f.dir}\nBase branch: main`))
  assert.match(setup.output, /Never push with git yourself.*request-push --help/)
  assert.deepEqual(f.recorded.map(({ method, endpoint }) => [method, endpoint]), [["POST", "/setup"], ["POST", "/read-token"]])
  const state = f.readState()
  assert.equal(state.baseSha, f.baseSha)
  assert.equal(state.token, token)
  assert.equal(state.dir, f.dir)
  assert.equal(state.root, f.taskRoot)
  assert.equal(statSync(f.taskRoot).mode & 0o777, 0o700)
  assert.equal(statSync(f.stateFile).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(f.taskRoot).sort(), ["openwork-code.mjs", "state.json", "storefront"])
  assert.deepEqual(readdirSync(f.home), [])
  assert.equal(f.git(f.dir, "config", "--local", "user.name"), author.name)
  assert.equal(f.git(f.dir, "config", "--local", "user.email"), author.email)
  const config = readFileSync(path.join(f.dir, ".git", "config"), "utf8")
  noSecrets(config)
  assert.doesNotMatch(config, /extraHeader|credential/i)
  assert.equal(f.git(f.dir, "remote", "get-url", "origin"), f.cloneUrl)
  assert.equal(new URL(f.cloneUrl).username, "")
  const result = await f.run("detect", "--json")
  assert.equal(result.exit, 0, result.output)
  const found = JSON.parse(result.output)
  assert.deepEqual(found.install[0], { command: "pnpm install --frozen-lockfile", source: "package.json packageManager" })
  assert.deepEqual(found.test[0], { command: "pnpm test", source: "package.json scripts.test" })
  assert.ok(found.install.some((entry: { source: string }) => entry.source === "CI: ci.yml"))
  assert.ok(found.test.some((entry: { command: string; source: string }) => entry.command === "pnpm test" && entry.source === "CI: ci.yml"))
  assert.ok(found.test.some((entry: { source: string }) => entry.source === "package.json scripts.typecheck"))
  assert.deepEqual(found.notes, ["README.md: Getting started", "README.md: Testing"])

  const total = "export const total = 42\n"
  const build = "#!/bin/sh\nprintf 'Build Acme Storefront\\n'\n"
  write(f.dir, "src/checkout/total.ts", total)
  write(f.dir, "scripts/build.sh", build)
  write(f.dir, "receipt.bin", binary)
  write(f.dir, "node_modules/x.js", "Ignored\n")
  write(f.dir, ".env", "IGNORED=1\n")
  rmSync(path.join(f.dir, "obsolete.txt"))
  const message = "Fix checkout rounding\n\nPreserve the total in whole cents.\n"
  write(f.taskRoot, "commit.txt", message)
  write(f.taskRoot, "pull-request.md", "Checkout totals should be whole cents.\n")
  const ask = await f.run("request-push", "--branch", "openwork/fix-rounding", "--title", "Fix checkout rounding", "--tests", "passed", "--test-command", "pnpm test", "--test-summary", "Checkout tests passed.", "--message-file", path.join(f.taskRoot, "commit.txt"), "--body-file", path.join(f.taskRoot, "pull-request.md"), "--wait-seconds", "0.25")
  assert.equal(ask.exit, 3, ask.output)
  assert.match(ask.output, /Asked Maya Chen to approve pushing 4 file\(s\) to a new branch openwork\/fix-rounding on acme\/storefront\./)
  assert.ok(ask.output.includes(`Still waiting for approval. Run: ${f.waitCommand}`))
  const inputRecord = f.recorded.find((entry) => entry.method === "POST" && entry.endpoint === "/push-approvals")
  assert.ok(inputRecord)
  const input = cloudCodingPushRequestSchema.parse(JSON.parse(inputRecord.raw))
  assert.deepEqual(input, {
    changeSet: {
      branch: "openwork/fix-rounding", baseSha: f.baseSha, commitMessage: message,
      files: [
        { path: "obsolete.txt", deleted: true },
        { path: "receipt.bin", mode: "100644", contentBase64: binary.toString("base64") },
        { path: "scripts/build.sh", mode: "100755", contentBase64: Buffer.from(build).toString("base64") },
        { path: "src/checkout/total.ts", mode: "100644", contentBase64: Buffer.from(total).toString("base64") },
      ],
    },
    title: "Fix checkout rounding", body: "Checkout totals should be whole cents.\n",
    tests: { status: "passed", command: "pnpm test", summary: "Checkout tests passed." },
  })
  assert.ok(f.recorded.some((entry) => entry.method === "GET" && /^\?waitMs=\d+$/.test(entry.query)))
  assert.equal(f.git(f.dir, "branch", "--show-current"), input.changeSet.branch)
  assert.equal(f.git(f.dir, "log", "-1", "--format=%an <%ae>"), `${author.name} <${author.email}>`)

  write(f.dir, "src/checkout/total.ts", "export const total = 100\n")
  f.git(f.dir, "add", "src/checkout/total.ts")
  f.git(f.dir, "commit", "-m", "Work after asking for approval")
  write(f.dir, "src/checkout/total.ts", "export const total = 101\n")
  const id = f.decide("approved")
  f.failOnce()
  const status = await f.run("status", "--json")
  assert.equal(status.exit, 0, status.output)
  assert.equal(JSON.parse(status.output).approval.status, "approved")
  assert.equal(f.recorded.filter((entry) => entry.endpoint === "/task").length, 2)
  const wait = await f.run("wait", "--wait-seconds", "0")
  const expected = `Pull request opened: ${prUrl}\n${repoName} #17 · branch openwork/fix-rounding\n${cleanupLine}`
  assert.deepEqual(wait, { exit: 0, output: expected })
  const pushes = f.recorded.filter((entry) => entry.endpoint === `/push-approvals/${id}/push`)
  assert.equal(pushes.length, 2)
  assert.ok(inputRecord.raw.startsWith(pushes[0].raw.slice(0, -1) + ","))
  assert.equal(pushes[1].raw, pushes[0].raw)
  assert.equal(f.recorded.filter((entry) => entry.endpoint === "/pull-requests").length, 2)
  assert.equal(f.recorded.filter((entry) => entry.endpoint === "/release").length, 1)
  assert.equal(existsSync(f.taskRoot), false)
  assert.deepEqual(readdirSync(f.home), [])
  assert.equal(f.git(f.root, "--git-dir", path.join(f.root, "storefront.git"), "rev-parse", "main"), f.baseSha)
})

test("stops on expired, superseded, mismatched, and refused approvals", async (t) => {
  const f = await taskFixture(t)
  assert.equal((await f.setup()).exit, 0)
  write(f.dir, "src/checkout/total.ts", "export const total = 10\n")
  for (const [status, exit] of [["expired", 5], ["superseded", 5]] as const) {
    assert.equal((await f.request()).exit, 3)
    f.decide(status)
    const result = await f.run("wait", "--wait-seconds", "0")
    assert.equal(result.exit, exit)
    assert.ok(result.output.includes(status))
    assert.ok(existsSync(f.stateFile))
    assert.equal(f.recorded.filter((entry) => entry.endpoint === "/release").length, 0)
    assert.equal(f.recorded.filter((entry) => entry.endpoint.endsWith("/push")).length, 0)
  }
  assert.equal((await f.request()).exit, 3)
  f.decide("approved")
  f.mismatch()
  assert.deepEqual(await f.run("wait", "--wait-seconds", "0"), { exit: 1, output: "The approved commit did not match. Run request-push again to ask for a new approval.\n" })
  assert.equal(f.recorded.filter((entry) => entry.endpoint === "/pull-requests").length, 0)
  const count = f.recorded.length
  assert.deepEqual(await f.request("Gateway refusal"), { exit: 1, output: "Cloud coding is off. Ask an Acme Corp admin to turn it on.\n" })
  assert.equal(f.recorded.length, count + 1)
})

test("refuses empty, workflow, symlink, and oversize changes locally", async (t) => {
  const f = await taskFixture(t)
  write(f.root, "occupied/keep.txt", "Keep\n")
  const occupied = await f.setup(code, "--root", path.join(f.root, "occupied"))
  assert.equal(occupied.exit, 1)
  assert.match(occupied.output, /not empty/)
  assert.equal(f.recorded.length, 0)
  assert.equal((await f.setup()).exit, 0)
  let result = await f.request()
  assert.equal(result.exit, 1)
  assert.match(result.output, /no changes to push/i)
  const workflow = ".github/workflows/ci.yml"
  write(f.dir, workflow, "steps: []\n")
  result = await f.request()
  assert.equal(result.exit, 1)
  assert.match(result.output, /GitHub Actions workflows/)
  f.git(f.dir, "restore", "--source=HEAD", "--staged", "--worktree", "--", workflow)
  const link = path.join(f.dir, "readme-link")
  symlinkSync("README.md", link)
  result = await f.request()
  assert.equal(result.exit, 1)
  assert.match(result.output, /symlinks or submodules/)
  rmSync(link)
  write(f.dir, "oversize.bin", Buffer.alloc(1_000_001))
  result = await f.request()
  assert.equal(result.exit, 1)
  assert.match(result.output, /too large to push at once/)
  assert.deepEqual(f.recorded.map(({ endpoint }) => endpoint), ["/setup", "/read-token"])
  assert.equal(f.git(f.dir, "rev-parse", "HEAD"), f.baseSha)
})

test("setup rotates a credential without replacing the checkout or pending approval", async (t) => {
  const f = await taskFixture(t)
  assert.equal((await f.setup()).exit, 0)
  write(f.dir, "src/checkout/total.ts", "export const total = 10\n")
  assert.equal((await f.request()).exit, 3)
  write(f.dir, "later.txt", "Not part of the approved commit\n")
  const saved = f.readState()
  const resumed = await f.setup(resumeCode)
  assert.equal(resumed.exit, 0, resumed.output)
  assert.ok(resumed.output.includes(`Push approval: pending\nRun: ${f.waitCommand}\n`))
  assert.deepEqual(f.readState(), { ...saved, token: resumedToken, tokenExpiresAt: "2030-01-02T00:00:00.000Z" })
  assert.equal(f.git(f.dir, "rev-parse", "HEAD"), saved.approval.commit)
  assert.equal(readFileSync(path.join(f.dir, "later.txt"), "utf8"), "Not part of the approved commit\n")
  assert.equal(f.recorded.filter((entry) => entry.endpoint === "/read-token").length, 1)
  f.decide("approved")
  const wait = await f.run("wait", "--wait-seconds", "0")
  assert.equal(wait.exit, 0, wait.output)
  const renewal = f.recorded.findLastIndex((entry) => entry.endpoint === "/setup")
  assert.deepEqual(f.recorded.slice(renewal + 1).map((entry) => entry.authorization), Array(5).fill(`Bearer ${resumedToken}`))
  assert.equal(existsSync(f.taskRoot), false)
})

test("setup refuses a different task's code without changing local state", async (t) => {
  const f = await taskFixture(t)
  assert.equal((await f.setup()).exit, 0)
  const saved = f.readState()
  assert.deepEqual(await f.setup(otherCode), { exit: 1, output: "This folder belongs to another task.\n" })
  assert.deepEqual(f.readState(), saved)
  assert.equal(f.git(f.dir, "rev-parse", "HEAD"), f.baseSha)
})

test("an ended credential tells the caller to resume the task", async (t) => {
  const f = await taskFixture(t)
  assert.equal((await f.setup()).exit, 0)
  const saved = f.readState()
  const hint = `The credential for this task has ended. Call cloud-coding:start again with taskId ${taskId} and run the new setup command.\n`
  writeFileSync(f.stateFile, JSON.stringify({ ...saved, token: null }))
  const count = f.recorded.length
  assert.deepEqual(await f.run("wait"), { exit: 6, output: hint })
  assert.deepEqual(await f.request(), { exit: 6, output: hint })
  assert.deepEqual(await f.run("status"), { exit: 6, output: hint })
  assert.equal(f.recorded.length, count)
  writeFileSync(f.stateFile, JSON.stringify(saved))
  f.closeCredential()
  assert.deepEqual(await f.run("status"), { exit: 6, output: "This task credential is not active: [redacted]\n" + hint })
  assert.ok(existsSync(f.taskRoot))
})

test("denial releases the credential and deletes the whole root without pushing", async (t) => {
  const f = await taskFixture(t)
  assert.equal((await f.setup()).exit, 0)
  write(f.dir, "src/checkout/total.ts", "export const total = 10\n")
  assert.equal((await f.request()).exit, 3)
  const id = f.decide("denied")
  const result = await f.run("wait", "--wait-seconds", "0")
  assert.deepEqual(result, { exit: 4, output: "The push was denied. Nothing was pushed. Ask what they would like changed.\n" + cleanupLine })
  assert.equal(existsSync(f.taskRoot), false)
  assert.deepEqual(f.recorded.slice(-2).map((entry) => entry.endpoint), [`/push-approvals/${id}`, "/release"])
  assert.ok(f.recorded.every((entry) => !entry.endpoint.endsWith("/push")))
})

test("finish refuses unsafe roots and cleans its own root despite a failed release", async (t) => {
  const f = await taskFixture(t)
  const unsafe = await f.run("finish", "--root", "/")
  assert.equal(unsafe.exit, 1)
  const unrelated = path.join(f.root, "unrelated")
  write(unrelated, "keep.txt", "keep\n")
  const missing = await f.run("finish", "--root", unrelated)
  assert.equal(missing.exit, 1)
  assert.equal(readFileSync(path.join(unrelated, "keep.txt"), "utf8"), "keep\n")
  assert.equal(f.recorded.length, 0)
  assert.equal((await f.setup()).exit, 0)
  const parent = path.join(f.root, "other-parent")
  const otherRepo = path.join(parent, "other-repo")
  mkdirSync(otherRepo, { recursive: true })
  f.git(otherRepo, "init")
  write(parent, "state.json", JSON.stringify({ ...f.readState(), root: parent, dir: path.join(parent, "storefront") }))
  const inOtherRepo = await f.runFrom(otherRepo, "finish", "--root", parent)
  assert.equal(inOtherRepo.exit, 1)
  assert.match(inOtherRepo.output, /existing repository or its parent/)
  assert.ok(existsSync(path.join(otherRepo, ".git")))
  f.failRelease()
  assert.deepEqual(await f.runFrom(f.dir, "finish"), { exit: 0, output: cleanupLine })
  assert.equal(existsSync(f.taskRoot), false)
  assert.equal(f.recorded.filter((entry) => entry.endpoint === "/release").length, 1)
  assert.deepEqual(readdirSync(f.home), [])
})

test("pending waits take the capped duration even when a larger duration is requested", async (t) => {
  const cap = 300
  const f = await taskFixture(t, cap)
  assert.equal((await f.setup()).exit, 0)
  write(f.dir, "src/checkout/total.ts", "export const total = 10\n")
  const request = await f.request("Wait too long", "--wait-seconds", "9999")
  assert.equal(request.exit, 3, request.output)
  const wait = await f.run("wait")
  assert.equal(wait.exit, 3, wait.output)
  const pollTimes = f.recorded.flatMap(({ query }) => query ? [Number(new URLSearchParams(query).get("waitMs"))] : [])
  assert.ok(pollTimes.length >= 2)
  assert.ok(pollTimes.every((ms) => ms > 0 && ms <= cap))
})

for (const fixture of [
  { name: "npm", files: { "package.json": '{"scripts":{"test":"node --test"}}', "package-lock.json": "{}" }, install: "npm ci", test: "npm test" },
  { name: "yarn", files: { "package.json": '{"packageManager":"yarn@4.0.0","scripts":{"test":"node --test"}}', "yarn.lock": "" }, install: "yarn install --immutable", test: "yarn test" },
  { name: "bun", files: { "package.json": '{"scripts":{"test":"bun test"}}', "bun.lockb": "" }, install: "bun install --frozen-lockfile", test: "bun test" },
  { name: "Makefile", files: { Makefile: "deps:\n\ttrue\ncheck:\n\ttrue\n" }, install: "make deps", test: "make check" },
  { name: "Poetry", files: { "pyproject.toml": "[tool.poetry]\n", "pytest.ini": "[pytest]\n" }, install: "poetry install", test: "poetry run pytest" },
  { name: "uv", files: { "pyproject.toml": "[project]\n", "uv.lock": "", "pytest.ini": "[pytest]\n" }, install: "uv sync", test: "uv run pytest" },
  { name: "pip", files: { "requirements.txt": "pytest\n" }, install: "python -m pip install -r requirements.txt", test: "pytest" },
  { name: "tox", files: { "pyproject.toml": "[project]\n", "tox.ini": "[tox]\n" }, install: "python -m pip install -e .", test: "tox" },
  { name: "Go", files: { "go.mod": "module acme/storefront\n" }, test: "go test ./..." },
  { name: "Rust", files: { "Cargo.toml": "[package]\n" }, test: "cargo test" },
  { name: "Ruby", files: { Gemfile: 'gem "rspec"\n' }, install: "bundle install", test: "bundle exec rspec" },
]) {
  test(`detects ${fixture.name} commands without running them`, async (t) => {
    const f = workspace(t)
    const dir = path.join(f.root, "storefront")
    mkdirSync(dir)
    for (const [name, contents] of Object.entries(fixture.files)) if (contents !== undefined) write(dir, name, contents)
    const detected = await f.run("detect", "--dir", dir, "--json")
    assert.equal(detected.exit, 0, detected.output)
    const output = JSON.parse(detected.output)
    assert.equal(output.install[0]?.command, fixture.install)
    assert.equal(output.test[0]?.command, fixture.test)
  })
}
