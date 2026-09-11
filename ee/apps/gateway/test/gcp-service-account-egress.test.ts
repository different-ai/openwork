import assert from "node:assert/strict"
import { test } from "node:test"
import https from "node:https"
import dns from "node:dns/promises"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import type { LookupFunction } from "node:net"
import { generateKeyPairSync } from "node:crypto"
import { createGcpServiceAccountTokenMinter } from "../src/credentials/gcp-service-account.js"
import { createGoogleOauthRefresher } from "../src/credentials/google-oauth-refresh.js"
import { memoryStore, now, refreshInput } from "./google-oauth-refresh-fixture.js"

test("OAuth and SA default transports use socket-bound DNS guards, never global fetch or origin exceptions", async (t) => {
  const destinations: string[] = []
  let rejectedPrivateAnswers = 0
  let globalFetchCalls = 0
  const exception = process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS
  process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = "https://oauth2.googleapis.com"
  t.mock.method(globalThis, "fetch", async () => { globalFetchCalls++; throw new Error("Global fetch must not run") })
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }])
  // No real sockets or DNS. Exercise the lookup supplied to the actual Node
  // transport, not a resolve/check followed by a second fetch resolution.
  t.mock.method(https, "request", (url: URL, options: { lookup?: LookupFunction; agent?: boolean }) => {
    destinations.push(url.href)
    assert.equal(options.agent, false)
    assert.equal(typeof options.lookup, "function")
    const outgoing = Object.assign(new EventEmitter(), { end() {}, write() { return true }, destroy() {} })
    queueMicrotask(() => options.lookup!(url.hostname, { all: true }, (error) => {
      assert.equal(error?.message, "Inference egress destination is not permitted.")
      rejectedPrivateAnswers++
      outgoing.emit("error", error)
    }))
    return outgoing
  })
  syncBuiltinESMExports()
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const minter = createGcpServiceAccountTokenMinter()
    assert.deepEqual(await minter({ credentialId: "ipc_sa", now, serviceAccount: {
      client_email: "test@example.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://oauth2.googleapis.com/token",
    } }), { kind: "error", message: "token endpoint unavailable" })
    const { store, state } = memoryStore()
    assert.deepEqual(await createGoogleOauthRefresher({ store })(refreshInput()), { kind: "retry", reason: "refresh_unavailable" })
    assert.equal(state.row?.status, "active")
    assert.deepEqual(destinations, ["https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token"])
    assert.equal(rejectedPrivateAnswers, 2)
    assert.equal(globalFetchCalls, 0)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (exception === undefined) delete process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS
    else process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = exception
  }
})
