import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { isSandboxError, withBlocks, type SandboxSpec } from "@openwork/sandbox"
import { sandboxBlockConformanceCases, sandboxProviderConformanceCases } from "@openwork/sandbox/testing"
import { createMicrosandboxProvider } from "./index.js"

// Opt-in: boots real microVMs on this computer (Apple Silicon macOS, or Linux with KVM) and deletes them in finally.
// MICROSANDBOX_LIVE=1 [MSB_HOME=/short/path] [SANDBOX_TEST_IMAGE=alpine] pnpm test:live
// MSB_HOME must be short: macOS limits the runtime's socket path to 104 bytes.
const skip = process.env.MICROSANDBOX_LIVE === "1" ? false : "set MICROSANDBOX_LIVE=1"
const image = process.env.SANDBOX_TEST_IMAGE ?? "alpine"
const opts = { timeoutMs: 120_000 }
const run = promisify(execFile)

function spec(extra: Partial<SandboxSpec> = {}): SandboxSpec {
  const key = `live-${randomUUID()}`
  return { idempotencyKey: key, image: null, labels: { "openwork.sandbox.scope": key }, env: {}, storage: [], exposePorts: [], ...extra }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address !== null && typeof address === "object") resolve(address.port)
      else reject(new Error("No loopback port is available"))
    })
  })
}

const offline = () => createMicrosandboxProvider({ image, network: { egress: "none" } })
for (const c of sandboxProviderConformanceCases(offline, opts)) test(`live: ${c.name}`, { skip, timeout: 180_000 }, c.run)
for (const c of sandboxBlockConformanceCases(offline, ["run", "files", "pause"])) test(`live: ${c.name}`, { skip, timeout: 180_000 }, c.run)

test("live: the guest sees only its mounts, and a read-only mount cannot be written", { skip, timeout: 180_000 }, async () => {
  // microsandbox refuses a bind mount whose host path goes through a symlink, as the macOS temp directory does.
  const readOnly = await realpath(await mkdtemp(join(tmpdir(), "msb-ro-")))
  const readWrite = await realpath(await mkdtemp(join(tmpdir(), "msb-rw-")))
  await writeFile(join(readOnly, "input.txt"), "from the host")
  const provider = createMicrosandboxProvider({
    image,
    network: { egress: "none" },
    mounts: [{ hostPath: readOnly, guestPath: "/input", access: "ro" }, { hostPath: readWrite, guestPath: "/output", access: "rw" }],
  })
  const { run: exec } = withBlocks(provider, ["run"])
  const handle = await provider.create(spec(), opts)
  try {
    const result = await exec(handle, { ...opts, command: "cat /input/input.txt > /output/copy.txt; echo changed > /input/input.txt; echo $?" })
    assert.equal(result.stdout.trim(), "1")
    assert.equal(await readFile(join(readWrite, "copy.txt"), "utf8"), "from the host")
    assert.equal(await readFile(join(readOnly, "input.txt"), "utf8"), "from the host")
    const outside = await exec(handle, { ...opts, command: `ls ${readOnly} 2>/dev/null | wc -l` })
    assert.equal(outside.stdout.trim(), "0")
  } finally {
    await provider.destroy(handle, opts)
    await rm(readOnly, { recursive: true, force: true })
    await rm(readWrite, { recursive: true, force: true })
  }
})

test("live: a read-only folder inside a writable mount cannot be changed, moved or removed", { skip, timeout: 180_000 }, async () => {
  // OpenWork mounts a workspace's .git and .opencode this way, so the guest cannot plant config the host runs.
  const root = await realpath(await mkdtemp(join(tmpdir(), "msb-nested-")))
  await mkdir(join(root, ".git"))
  await writeFile(join(root, ".git", "config"), "[core]\n")
  const provider = createMicrosandboxProvider({ image, network: { egress: "none" }, mounts: [
    { hostPath: root, guestPath: root, access: "rw" }, { hostPath: join(root, ".git"), guestPath: join(root, ".git"), access: "ro" }] })
  const { run: exec } = withBlocks(provider, ["run"])
  const handle = await provider.create(spec(), opts)
  try {
    const result = await exec(handle, { ...opts, command: `cd ${root}; echo x > top.txt; echo $?; echo y >> .git/config; echo $?; mv .git moved; echo $?; rm -rf .git; echo $?` })
    assert.deepEqual(result.stdout.trim().split("\n"), ["0", "1", "1", "1"])
    assert.equal(await readFile(join(root, ".git", "config"), "utf8"), "[core]\n")
    assert.equal(await readFile(join(root, "top.txt"), "utf8"), "x\n")
  } finally {
    await provider.destroy(handle, opts)
    await rm(root, { recursive: true, force: true })
  }
})

test("live: with egress none the guest reaches nothing, and a published port still answers on loopback", { skip, timeout: 180_000 }, async () => {
  const provider = offline()
  const { run: exec } = withBlocks(provider, ["run"])
  const handle = await provider.create(spec({ exposePorts: [8080] }), opts)
  try {
    const egress = await exec(handle, { ...opts, command: "wget -T 5 -q -O- http://example.com >/dev/null 2>&1; echo $?" })
    assert.notEqual(egress.stdout.trim(), "0")
    await exec(handle, { ...opts, command: "(while true; do printf 'HTTP/1.0 200 OK\\r\\n\\r\\nfrom the guest' | nc -l -p 8080; done) >/dev/null 2>&1 &" })
    const endpoint = await provider.endpoint(handle, 8080)
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const preview = await run("curl", ["-s", "-m", "10", "--retry", "5", "--retry-connrefused", endpoint.url])
    assert.equal(preview.stdout, "from the guest")
    await assert.rejects(provider.endpoint(handle, 9090), error => isSandboxError(error) && error.code === "invalid_state")
  } finally {
    await provider.destroy(handle, opts)
  }
})

test("live: an allow-list reaches its hosts over HTTP and HTTPS and nothing else, by name or by address", { skip, timeout: 180_000 }, async () => {
  const provider = createMicrosandboxProvider({ image, network: { egress: "allow-list", domains: ["example.com"] } })
  const { run: exec } = withBlocks(provider, ["run"])
  const handle = await provider.create(spec(), opts)
  try {
    const allowed = await exec(handle, { ...opts, command: "wget -T 20 -q -O- https://example.com | head -c 15; wget -T 20 -q -O- http://example.com | head -c 15" })
    assert.equal(allowed.stdout.toLowerCase(), "<!doctype html><!doctype html>")
    const denied = await exec(handle, { ...opts, command: "for url in https://example.org http://example.org http://1.1.1.1; do wget -T 5 -q -O- $url >/dev/null 2>&1; echo $?; done" })
    assert.doesNotMatch(denied.stdout, /^0$/m)
    assert.equal(denied.stdout.trim().split("\n").length, 3)
  } finally {
    await provider.destroy(handle, opts)
  }
})

test("live: a create that runs out of time is called off and leaves no sandbox under that name", { skip, timeout: 180_000 }, async () => {
  const provider = offline()
  const wanted = spec()
  await assert.rejects(provider.create(wanted, { timeoutMs: 1 }), error => isSandboxError(error) && error.code === "timeout")
  assert.equal(await provider.find({ idempotencyKey: wanted.idempotencyKey }), null)
  const handle = await provider.create(wanted, opts)
  try {
    assert.equal(handle.state, "running")
  } finally {
    await provider.destroy(handle, opts)
  }
})

test("live: a preview port taken by another program is chosen again and the failed sandbox is removed", { skip, timeout: 180_000 }, async () => {
  const blocker = createServer()
  const taken = await listen(blocker)
  const spare = createServer()
  const free = await listen(spare)
  await new Promise(resolve => spare.close(resolve))
  const offers = [taken, free]
  const provider = createMicrosandboxProvider({ image, network: { egress: "none" } }, { allocatePort: async () => offers.shift() ?? free })
  const { run: exec } = withBlocks(provider, ["run"])
  const handle = await provider.create(spec({ exposePorts: [8080] }), opts)
  try {
    assert.deepEqual(offers, [])
    assert.equal((await provider.endpoint(handle, 8080)).url, `http://127.0.0.1:${free}`)
    assert.equal((await exec(handle, { ...opts, command: "echo up" })).stdout, "up\n")
  } finally {
    await provider.destroy(handle, opts)
    blocker.close()
  }
})

test("live: a command that outlives its timeout fails as a timeout and is not left running", { skip, timeout: 180_000 }, async () => {
  const provider = offline()
  const { run: exec } = withBlocks(provider, ["run"])
  const handle = await provider.create(spec(), opts)
  try {
    await assert.rejects(exec(handle, { command: "sleep 60", timeoutMs: 1_000 }), error => isSandboxError(error) && error.code === "timeout" && !error.retryable)
    const left = await exec(handle, { ...opts, command: "ps | grep -c '[s]leep 60'" })
    assert.equal(left.stdout.trim(), "0")
  } finally {
    await provider.destroy(handle, opts)
  }
})
