import assert from "node:assert/strict"
import { test } from "node:test"
import { withBlocks } from "@openwork/sandbox"
import { createDaytonaProvider, type DaytonaClient, type DaytonaSandboxClient } from "./index.js"
function fixture(hang = false) {
  const paths: string[] = []
  let launches = 0
  const box: DaytonaSandboxClient = {
    id: "test", state: "started", target: null,
    refreshData: async () => {}, start: async () => {}, stop: async () => {}, delete: async () => {},
    getSignedPreviewUrl: async () => ({ url: "https://example.com" }),
    fs: {
      createFolder: async p => { paths.push(p) },
      uploadFile: async () => {}, setFilePermissions: async () => {}, deleteFile: async () => {},
      downloadFile: async p => new TextEncoder().encode(p.endsWith("/stderr") ? "error\n\n" : "out without newline"),
      getFileDetails: async () => ({ size: 2, isDir: false }),
    },
    process: {
      createSession: async () => {},
      executeSessionCommand: async () => { launches++; if (hang) return new Promise<never>(() => {}); return { cmdId: "command" } },
      getSessionCommand: async () => ({ exitCode: 7 }),
      getSessionCommandLogs: async () => ({ stdout: "normalized\n", stderr: "normalized\n" }),
    },
  }
  const client: DaytonaClient = { create: async () => box, get: async () => box, list: async function* () {}, volume: { get: async () => ({ id: "volume", state: "ready" }) } }
  const provider = createDaytonaProvider({ apiKey: "not-used", apiUrl: "https://example.com", snapshot: "test", image: "test", resources: { cpu: 1, memoryGb: 1, diskGb: 4 }, helperCreateTimeoutMs: 1000, pollIntervalMs: 1, platform: { os: "linux", isolation: "container" } }, { client })
  return { provider, paths, launched: () => launches }
}
const spec = { workerId: "", idempotencyKey: "test", image: null, env: {}, labels: {}, storage: [], exposePorts: [] }
test("run returns exact streams and exit status, not normalized session logs", async () => {
  const f = fixture()
  const h = await f.provider.create(spec, { timeoutMs: 1000 })
  const result = await withBlocks(f.provider, ["run"]).run(h, { command: "printf example", timeoutMs: 1000 })
  assert.deepEqual(result, { exitCode: 7, stdout: "out without newline", stderr: "error\n\n" })
  assert.equal(f.launched(), 1)
})
test("unsupported shell is rejected before a process launches", async () => {
  const f = fixture()
  const h = await f.provider.create(spec, { timeoutMs: 1000 })
  await assert.rejects(withBlocks(f.provider, ["run"]).run(h, { command: "x", shell: "powershell", timeoutMs: 1000 }), /supports sh only/)
  assert.equal(f.launched(), 0)
})
test("pause is absent until the configured flavor explicitly supports it", () => {
  assert.throws(() => withBlocks(fixture().provider, ["pause"], "job"), /requires pause/)
})

test("unknown launch timeout is not retried and never advertised as a killed command", async () => {
  const f = fixture(true)
  const h = await f.provider.create(spec, { timeoutMs: 1000 })
  await assert.rejects(withBlocks(f.provider, ["run"]).run(h, { command: "side effect", timeoutMs: 20 }), e => {
    assert.ok(e instanceof Error)
    assert.match(e.message, /outcome.*unknown|deadline/)
    return true
  })
  assert.equal(f.launched(), 1)
})

test("routes offers the preview proxy and the SSH gateway; release revokes the SSH token", async () => {
  const f = fixture()
  const h = await f.provider.create(spec, { timeoutMs: 1000 })
  const revoked: string[] = []
  const withSsh = fixtureWithSsh(revoked)
  const routes = await withBlocks(withSsh, ["routes"]).routes(await withSsh.create(spec, { timeoutMs: 1000 }), 8081, { timeoutMs: 1000 })
  assert.deepEqual(routes.map((route) => route.label), ["daytona-preview", "daytona-ssh"])
  const ssh = routes[1]
  assert.ok(ssh?.kind === "ssh")
  assert.deepEqual({ host: ssh.host, port: ssh.port, user: ssh.user, target: ssh.target }, { host: "ssh.example.test", port: 2222, user: "ssh-token", target: { port: 8081 } })
  await ssh.release?.()
  assert.deepEqual(revoked, ["ssh-token"])
  // A client without SSH access still offers the preview route rather than failing.
  assert.deepEqual((await withBlocks(f.provider, ["routes"]).routes(h, 8081, { timeoutMs: 1000 })).map((route) => route.label), ["daytona-preview"])
})

function fixtureWithSsh(revoked: string[]) {
  const box: DaytonaSandboxClient = {
    id: "ssh", state: "started", target: null,
    refreshData: async () => {}, start: async () => {}, stop: async () => {}, delete: async () => {},
    getSignedPreviewUrl: async () => ({ url: "https://8081-signed.example.com" }),
    createSshAccess: async () => ({ token: "ssh-token", sshCommand: "ssh -p 2222 ssh-token@ssh.example.test" }),
    revokeSshAccess: async (token) => { revoked.push(token) },
    fs: { createFolder: async () => {}, uploadFile: async () => {}, setFilePermissions: async () => {}, deleteFile: async () => {} },
    process: { createSession: async () => {}, executeSessionCommand: async () => ({ cmdId: "c" }), getSessionCommand: async () => ({ exitCode: 0 }), getSessionCommandLogs: async () => ({}) },
  }
  const client: DaytonaClient = { create: async () => box, get: async () => box, list: async function* () {}, volume: { get: async () => ({ id: "volume", state: "ready" }) } }
  return createDaytonaProvider({ apiKey: "not-used", apiUrl: "https://example.com", snapshot: "test", image: "test", resources: { cpu: 1, memoryGb: 1, diskGb: 4 }, helperCreateTimeoutMs: 1000, pollIntervalMs: 1 }, { client })
}
