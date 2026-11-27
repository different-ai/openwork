import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { once } from "node:events"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
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
  for (const secret of [code, token, readToken, basic]) assert.equal(output.includes(secret), false, "output contained a credential")
}

function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "openwork-code-test-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, "home")
  mkdirSync(home)
  const script = path.join(root, "openwork-code.mjs")
  writeFileSync(script, OPENWORK_CODE_HELPER_SOURCE)
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }

  function run(...args: string[]) {
    return new Promise<{ exit: number | string | null; output: string }>((resolve, reject) => {
      execFile(process.execPath, [script, ...args], { cwd: root, env, timeout: 12_000 }, (error, stdout, stderr) => {
        try {
          noSecrets(stdout + stderr)
          assert.equal(stderr, "")
          resolve({ exit: error ? error.code ?? null : 0, output: stdout })
        } catch (err) { reject(err) }
      })
    })
  }

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  return { root, home, script, run, git }
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
  const recorded: { method: string; endpoint: string; query: string; raw: string }[] = []
  const requested = new Map<string, ReturnType<typeof cloudCodingPushRequestSchema.parse>>()
  const approvals = new Map<string, { id: string; status: CloudCodingPushApprovalStatus; branch: string; headSha: string; repositoryFullName: string; pullRequest: { number: number; url: string; state: "open" } | null }>()
  let approvalNumber = 0
  let redeemed = false
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
      recorded.push({ method, endpoint, query: url.search, raw })
      if (method === "POST" && endpoint === "/setup") {
        assert.equal(req.headers.authorization, undefined)
        if (redeemed || cloudCodingGatewaySetupInputSchema.parse(body).code !== code) return send(403, { error: "task_closed", message: "This setup code has already been used. Ask for a fresh one." })
        redeemed = true
        return send(200, { ...task, token, tokenExpiresAt: expires })
      }
      assert.ok(req.headers.authorization === `Bearer ${token}`, "gateway request did not carry the task token")
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
    mismatch() { mismatch = true },
  }
}

async function taskFixture(t: TestContext) {
  const files = workspace(t)
  const bare = seed(files.root, files.git)
  const stub = await stubGateway(t, bare.cloneUrl)
  const dir = path.join(files.root, "storefront")
  const setup = (...args: string[]) => files.run("setup", "--api", stub.api, "--code", code, ...args)
  const request = (title = "Fix checkout rounding", ...args: string[]) => files.run("request-push", "--branch", "openwork/fix-rounding", "--title", title, "--tests", "not_run", "--wait-seconds", "0", ...args)
  const stateDir = path.join(files.home, ".openwork", "cloud-coding")
  return { ...files, ...bare, ...stub, dir, setup, request, stateDir }
}

test("approval and push carry byte-identical Git changes from the embedded helper", async (t) => {
  const f = await taskFixture(t)
  execFileSync(process.execPath, ["--check", f.script])
  const setup = await f.setup()
  assert.equal(setup.exit, 0, setup.output)
  assert.ok(setup.output.includes(`Work in: ${f.dir}\nBase branch: main`))
  assert.match(setup.output, /Never push with git yourself.*request-push --help/)
  assert.deepEqual(f.recorded.map(({ method, endpoint }) => [method, endpoint]), [["POST", "/setup"], ["POST", "/read-token"]])
  const again = await f.setup("--dir", f.dir)
  assert.equal(again.exit, 0, again.output)
  assert.equal(again.output, "This task is already set up.\n" + setup.output)
  assert.equal(f.recorded.length, 2)
  const stateFile = path.join(f.stateDir, taskId + ".json")
  const state = JSON.parse(readFileSync(stateFile, "utf8"))
  assert.equal(state.baseSha, f.baseSha)
  assert.equal(state.token, token)
  assert.equal(state.dir, f.dir)
  assert.equal(statSync(f.stateDir).mode & 0o777, 0o700)
  assert.equal(statSync(stateFile).mode & 0o777, 0o600)
  assert.equal(f.git(f.dir, "config", "--local", "user.name"), author.name)
  assert.equal(f.git(f.dir, "config", "--local", "user.email"), author.email)
  const config = readFileSync(path.join(f.dir, ".git", "config"), "utf8")
  noSecrets(config)
  assert.doesNotMatch(config, /extraHeader|credential/i)
  assert.equal(f.git(f.dir, "remote", "get-url", "origin"), f.cloneUrl)
  assert.equal(new URL(f.cloneUrl).username, "")
  const result = await f.run("detect", "--dir", f.dir, "--json")
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
  write(f.root, "commit.txt", message)
  write(f.root, "body.txt", "Checkout totals should be whole cents.\n")
  const ask = await f.run("request-push", "--task", taskId, "--branch", "openwork/fix-rounding", "--title", "Fix checkout rounding", "--tests", "passed", "--test-command", "pnpm test", "--test-summary", "Checkout tests passed.", "--message-file", "commit.txt", "--body-file", "body.txt", "--wait-seconds", "0.01")
  assert.equal(ask.exit, 3, ask.output)
  assert.match(ask.output, /Asked Maya Chen to approve pushing 4 file\(s\) to a new branch openwork\/fix-rounding on acme\/storefront\./)
  assert.ok(ask.output.includes(`Still waiting for approval. Run: node ${JSON.stringify(f.script)} wait --task ${taskId}`))
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
  const wait = await f.run("wait", "--task", taskId, "--wait-seconds", "0")
  const expected = `Pull request opened: ${prUrl}\n${repoName} #17 · branch openwork/fix-rounding\n`
  assert.deepEqual(wait, { exit: 0, output: expected })
  const pushes = f.recorded.filter((entry) => entry.endpoint === `/push-approvals/${id}/push`)
  assert.equal(pushes.length, 2)
  assert.ok(inputRecord.raw.startsWith(pushes[0].raw.slice(0, -1) + ","))
  assert.equal(pushes[1].raw, pushes[0].raw)
  assert.equal(f.recorded.filter((entry) => entry.endpoint === "/pull-requests").length, 2)
  assert.deepEqual(await f.run("wait", "--wait-seconds", "0"), { exit: 0, output: expected })
  assert.equal(f.recorded.filter((entry) => entry.endpoint.endsWith("/push")).length, 2)
  const status = await f.run("status", "--json")
  assert.equal(status.exit, 0, status.output)
  assert.equal(JSON.parse(status.output).approval.pullRequest.url, prUrl)
  assert.equal(f.recorded.filter((entry) => entry.endpoint === "/task").length, 2)
  assert.ok((await f.run("status")).output.includes("Pull request: " + prUrl))
  assert.equal(f.git(f.root, "--git-dir", path.join(f.root, "storefront.git"), "rev-parse", "main"), f.baseSha)
})

test("stops on denied, expired, superseded, mismatched, and refused approvals", async (t) => {
  const f = await taskFixture(t)
  assert.equal((await f.setup()).exit, 0)
  write(f.dir, "src/checkout/total.ts", "export const total = 10\n")
  for (const [status, exit] of [["denied", 4], ["expired", 5], ["superseded", 5]] as const) {
    assert.equal((await f.request()).exit, 3)
    f.decide(status)
    const result = await f.run("wait", "--wait-seconds", "0")
    assert.equal(result.exit, exit)
    assert.ok(result.output.includes(status))
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
  const occupied = await f.setup("--dir", path.join(f.root, "occupied"))
  assert.equal(occupied.exit, 1)
  assert.match(occupied.output, /not an empty folder/)
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
