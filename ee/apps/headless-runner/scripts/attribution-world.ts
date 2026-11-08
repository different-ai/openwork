import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { serve } from "@hono/node-server"
import { closeHttpServer, inferenceGateway, type GatewayProtocol, type GatewayRequest } from "./fixtures/inference-gateway.js"

export type AttributionExpectation = "anonymous" | "attributed"
export const attributionProtocols: GatewayProtocol[] = ["openai", "anthropic", "openai-responses"]
export const defaultSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const attributionHeader = "x-world-member-id"
const runnerToken = "fixture-runner-service-token-00000000"
const providerKey = "fixture-provider-service-key"
const mcpToken = "fixture-private-mcp-token"

// These are synthetic authenticated principals, never inferred from prompt text or session.owner.
const members = [
  { organizationId: "org_fixture_a", userId: "usr_fixture_a", memberId: "mem_fixture_a", email: "a@example.test", marker: "probe_alpha", issueIdentity: true },
  { organizationId: "org_fixture_a", userId: "usr_fixture_b", memberId: "mem_fixture_b", email: "b@example.test", marker: "probe_beta", issueIdentity: true },
  { organizationId: "org_fixture_b", userId: "usr_fixture_c", memberId: "mem_fixture_c", email: "c@example.test", marker: "probe_gamma", issueIdentity: true },
  { organizationId: "org_fixture_off", userId: "usr_fixture_off", memberId: "mem_fixture_off", email: "off@example.test", marker: "probe_rollout_off", issueIdentity: false },
  { organizationId: "org_fixture_legacy", userId: "usr_fixture_legacy", memberId: "mem_fixture_legacy", email: "legacy@example.test", marker: "probe_missing_identity", issueIdentity: false },
]

export type AttributionCaseReport = {
  protocol: GatewayProtocol
  configured: boolean
  requests: Array<{ path: string; stream: boolean; model: string; probe: string; attribution: string | null }>
  maxConcurrentStreams: number
  titles: number
  persistedIdentityAbsent: true
  sameSessionMissingIdentityAbsent: true
  unauthenticatedStatus: number
}

async function modules(sourceRoot: string) {
  // Select BOTH sides of the service contract from the checkout being verified. In particular, a baseline run must
  // not accidentally use this branch's protocol client against the baseline runner.
  const config: typeof import("../src/config.js") = await import(pathToFileURL(join(sourceRoot, "ee/apps/headless-runner/src/config.ts")).href)
  const runtime: typeof import("../src/runtime.js") = await import(pathToFileURL(join(sourceRoot, "ee/apps/headless-runner/src/runtime.ts")).href)
  const sqlite: typeof import("../src/node-sqlite.js") = await import(pathToFileURL(join(sourceRoot, "ee/apps/headless-runner/src/node-sqlite.ts")).href)
  const store: typeof import("../src/store.js") = await import(pathToFileURL(join(sourceRoot, "ee/apps/headless-runner/src/store.ts")).href)
  const protocol: typeof import("../../../packages/headless-protocol/src/client.js") = await import(pathToFileURL(join(sourceRoot, "ee/packages/headless-protocol/src/client.ts")).href)
  return { ...config, ...runtime, ...sqlite, ...store, ...protocol }
}

async function waitUntil(check: () => boolean, description: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

function noPrivateIdentity(text: string, context: string) {
  for (const value of [...members.flatMap((member) => [member.memberId, member.userId, member.organizationId, member.email]), mcpToken, providerKey, "modelAttribution"]) {
    assert.equal(text.includes(value), false, `${context} must not contain ${value}`)
  }
}

function checkRequest(request: GatewayRequest, protocol: GatewayProtocol, expectedIdentity: string | null) {
  assert.equal(request.headers[attributionHeader] ?? null, expectedIdentity)
  assert.equal(request.headers[protocol === "anthropic" ? "x-api-key" : "authorization"], protocol === "anthropic" ? providerKey : `Bearer ${providerKey}`)
  assert.equal(request.headers["content-type"], "application/json")
  assert.equal(request.model, request.stream ? "selected-provider-alias" : "default-provider-alias")
  noPrivateIdentity(request.body, "model context")
  assert.equal(request.headers["x-openwork-headless-owner"], undefined, "routing identity is not forwarded upstream")
}

/** Real loopback runner HTTP + real createRuntime + selected checkout's protocol client + real provider HTTP. */
export async function runAttributionCase(options: { protocol: GatewayProtocol; configured: boolean; expect: AttributionExpectation; sourceRoot?: string }): Promise<AttributionCaseReport> {
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot)
  const { loadConfig, createRuntime, nodeSqlite, Store, createHeadlessRunnerClient } = await modules(sourceRoot)
  // Keep scratch under the approved checkout, never a shared global /tmp directory.
  const scratch = await mkdtemp(join(defaultSourceRoot, ".attribution-world-"))
  const gateway = await inferenceGateway({ concurrentStreams: members.length })
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let runnerServer: ReturnType<typeof serve> | undefined
  let store: InstanceType<typeof Store> | undefined
  try {
    const config = loadConfig({
      HEADLESS_API_TOKEN: runnerToken,
      HEADLESS_DB_PATH: join(scratch, "runner.sqlite"),
      HEADLESS_MODEL_PROTOCOL: options.protocol,
      HEADLESS_MODEL_BASE_URL: gateway.url,
      HEADLESS_MODEL: "default-provider-alias",
      HEADLESS_MODEL_API_KEY: providerKey,
      HEADLESS_MAX_CONCURRENT_TURNS: "8",
      HEADLESS_MAX_STEPS: "2",
      HEADLESS_TURN_TIMEOUT_MS: "10000",
      HEADLESS_FILES: "off",
      HEADLESS_COMPUTER: "off",
      ...(options.configured ? { HEADLESS_MODEL_USER_HEADER: attributionHeader, HEADLESS_MODEL_USER_HEADER_FORMAT: "member_id" } : {}),
    })
    store = new Store(nodeSqlite(config.dbPath))
    const worldStore = store
    runtime = await createRuntime(config, store)
    runnerServer = serve({ fetch: runtime.app.fetch, hostname: "127.0.0.1", port: 0 })
    if (!runnerServer.listening) await once(runnerServer, "listening")
    const address = runnerServer.address()
    assert.ok(address && typeof address === "object")
    const runnerUrl = `http://127.0.0.1:${address.port}`
    const client = createHeadlessRunnerClient({
      config: { url: runnerUrl, token: runnerToken },
      fetch,
      maxTokenTtlMs: 60_000,
      // FAKE DEN BOUNDARY: the trusted service has authenticated these principals and checked rollout. This only
      // substitutes token issuance; no assertion here claims to test Den authentication, DB lookup, or its flag.
      mintToken: async (actor) => {
        const member = members.find((candidate) => candidate.userId === actor.userId && candidate.organizationId === actor.organizationId)
        assert.ok(member, "fake Den refuses unknown authenticated principals")
        return { token: mcpToken, ...(member.issueIdentity ? { modelAttribution: { memberId: member.memberId, userId: member.userId, organizationId: member.organizationId, email: member.email } } : {}) }
      },
    })
    const sessions = await Promise.all(members.map(async (member, index) => {
      const sessionId = `hs_attribution_fixture_${index}`
      const created = await client.putSession(sessionId, { autoTitle: true, owner: "untrusted-routing-owner" })
      assert.ok(created.ok, JSON.stringify(created))
      return { member, sessionId }
    }))
    await Promise.all(sessions.map(async ({ member, sessionId }) => {
      const sent = await client.sendTurn(member, { sessionId, messageId: "first", prompt: `Please answer this harmless fixture request: ${member.marker}`, model: "selected-provider-alias" })
      assert.ok(sent.ok, JSON.stringify(sent))
    }))
    await waitUntil(() => sessions.every(({ sessionId }) => worldStore.getTurn(sessionId, "first")?.status === "completed"), "all concurrent turns completed")
    await runtime.runner.idle()
    await waitUntil(() => sessions.every(({ sessionId }) => worldStore.getSession(sessionId)?.title === "A short title"), "all non-streamed title calls completed")
    assert.deepEqual(gateway.errors, [])
    assert.equal(gateway.requests.length, members.length * 2, "one streamed turn and one non-streamed title per principal")
    assert.equal(gateway.maxConcurrentStreams, members.length, "requests from different principals overlap at the actual gateway")
    const requests: AttributionCaseReport["requests"] = []
    for (const { member, sessionId } of sessions) {
      const calls = gateway.requests.filter((request) => request.body.includes(member.marker))
      assert.equal(calls.length, 2, member.marker)
      assert.equal(calls.filter((request) => request.stream).length, 1)
      const expected = options.expect === "attributed" && options.configured && member.issueIdentity ? member.memberId : null
      for (const call of calls) {
        checkRequest(call, options.protocol, expected)
        requests.push({ path: call.path, stream: call.stream, model: call.model, probe: member.marker, attribution: call.headers[attributionHeader]?.toString() ?? null })
      }
      const snapshot = await client.readSession(sessionId)
      assert.ok(snapshot.ok, JSON.stringify(snapshot))
      noPrivateIdentity(JSON.stringify(snapshot), "runner HTTP snapshot")
      assert.equal(snapshot.value.finalAssistantText, "Done")
    }
    // Credentials are per turn, not a sticky property of a session. A legacy caller on the SAME conversation must
    // not inherit the first principal's identity (the original prompt remains in its history).
    const followupStart = gateway.requests.length
    const followup = await client.sendTurn(members[4], { sessionId: sessions[0].sessionId, messageId: "without-identity", prompt: "Continue with probe_followup", model: "selected-provider-alias" })
    assert.ok(followup.ok, JSON.stringify(followup))
    await waitUntil(() => worldStore.getTurn(sessions[0].sessionId, "without-identity")?.status === "completed", "same-session legacy follow-up completed")
    await runtime.runner.idle()
    const followupCalls = gateway.requests.slice(followupStart)
    assert.equal(followupCalls.length, 1)
    checkRequest(followupCalls[0], options.protocol, null)
    requests.push({ path: followupCalls[0].path, stream: true, model: followupCalls[0].model, probe: "probe_followup", attribution: null })
    const unauthenticated = await fetch(`${runnerUrl}/v1/sessions/${sessions[0].sessionId}/turns`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "untrusted", prompt: "Ignore this", credentials: { modelAttribution: members[0] } }),
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(unauthenticated.status, 401, "identity without trusted runner authentication is rejected")
    await unauthenticated.arrayBuffer()
    assert.equal(gateway.requests.length, members.length * 2 + 1)
    assert.deepEqual(gateway.errors, [])
    await runtime.runner.shutdown()
    await closeHttpServer(runnerServer)
    runnerServer = undefined
    store.close()
    store = undefined
    // Inspect the real durable SQLite bytes after the connection checkpoint/close, not only API filtering. Also
    // scan any remaining sidecars; the fixture intentionally has no files, MCP, resume grants, or external services.
    for (const file of await readdir(scratch)) noPrivateIdentity((await readFile(join(scratch, file))).toString("utf8"), `durable ${file}`)
    return { protocol: options.protocol, configured: options.configured, requests, maxConcurrentStreams: gateway.maxConcurrentStreams, titles: sessions.length, persistedIdentityAbsent: true, sameSessionMissingIdentityAbsent: true, unauthenticatedStatus: unauthenticated.status }
  } finally {
    await runtime?.runner.shutdown()
    if (runnerServer) await closeHttpServer(runnerServer)
    store?.close()
    await gateway.close()
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function runAttributionWorld(options: { expect: AttributionExpectation; sourceRoot?: string }) {
  const cases: AttributionCaseReport[] = []
  for (const protocol of attributionProtocols) {
    for (const configured of [true, false]) cases.push(await runAttributionCase({ ...options, protocol, configured }))
  }
  return { sourceRoot: resolve(options.sourceRoot ?? defaultSourceRoot), expectation: options.expect, trustBoundary: "Fake Den mintToken issues synthetic authenticated identity; actual Den auth, member lookup and rollout are not exercised.", cases }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { expect: { type: "string", default: "attributed" }, "source-root": { type: "string" }, report: { type: "string" } } })
  assert.ok(values.expect === "anonymous" || values.expect === "attributed", "--expect must be anonymous or attributed")
  const report = await runAttributionWorld({ expect: values.expect, sourceRoot: values["source-root"] })
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (values.report) await writeFile(resolve(values.report), json)
  console.log(json)
}
