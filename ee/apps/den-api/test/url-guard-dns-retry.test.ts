import assert from "node:assert/strict"
import { test } from "node:test"
import { PrivateUrlError, resolveHostAddresses, UnresolvedHostError } from "../src/capability-sources/url-guard.js"

const url = "https://chatgpt.com/oauth/client/client.json"

function dnsError(code: string) {
  return Object.assign(new Error(`getaddrinfo ${code} chatgpt.com`), { code })
}

function resolver(...results: Array<{ address: string }[] | Error>) {
  const calls: string[] = []
  const resolve = async (hostname: string) => {
    calls.push(hostname)
    const next = results.shift()
    if (!next) throw new Error("unexpected lookup")
    if (next instanceof Error) throw next
    return next
  }
  return { calls, resolve }
}

test("a temporary DNS failure is retried once before the host is judged", async () => {
  const { calls, resolve } = resolver(dnsError("EAI_AGAIN"), [{ address: "104.18.32.47" }])
  assert.deepEqual(await resolveHostAddresses(url, "chatgpt.com", resolve), [{ address: "104.18.32.47" }])
  assert.equal(calls.length, 2)
})

test("a DNS failure that persists is reported as temporary, not as a private host", async () => {
  const { calls, resolve } = resolver(dnsError("EAI_AGAIN"), dnsError("ETIMEOUT"))
  await assert.rejects(resolveHostAddresses(url, "chatgpt.com", resolve), (error) => {
    assert.ok(error instanceof UnresolvedHostError)
    assert.ok(error instanceof PrivateUrlError)
    assert.equal(error.temporary, true)
    return true
  })
  assert.equal(calls.length, 2)
})

test("a host that does not exist is refused at once", async () => {
  const { calls, resolve } = resolver(dnsError("ENOTFOUND"))
  await assert.rejects(resolveHostAddresses(url, "chatgpt.com", resolve), (error) => {
    assert.ok(error instanceof UnresolvedHostError)
    assert.equal(error.temporary, false)
    assert.match(error.message, /the hostname does not resolve/)
    return true
  })
  assert.equal(calls.length, 1)
})
