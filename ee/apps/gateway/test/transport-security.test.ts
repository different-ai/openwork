import assert from "node:assert/strict"
import { test } from "node:test"
import { createInferenceLookup, inferenceEgressAllowedOrigins, isPublicInferenceAddress, validateInferenceUrl } from "@openwork-ee/utils/inference-egress"
import { trackStream, upstreamLifetime } from "../src/relay.js"

test("socket lookup consumes only the exact validated DNS result, with all families checked", async () => {
  let calls = 0
  const lookup = createInferenceLookup(async () => {
    calls++
    // A second lookup would rebind to loopback. There must not be one.
    return calls === 1 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]
  })
  await new Promise<void>((resolve, reject) => {
    lookup("provider.test", { all: true }, (error, addresses) => {
      try { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]); resolve() } catch (failure) { reject(failure) }
    })
  })
  assert.equal(calls, 1)
  const mixed = createInferenceLookup(async () => [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:7f00:1", family: 6 }])
  await new Promise<void>((resolve, reject) => {
    mixed("provider.test", {}, (error) => { try { assert.ok(error); resolve() } catch (failure) { reject(failure) } })
  })
})

test("private, reserved, encoded and IPv6 transition addresses default deny", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001::1", "fc00::1", "fe80::1", "fe80::1%eth0", "ff02::1", "2001:db8::1"]) {
    assert.equal(isPublicInferenceAddress(address), false, address)
  }
  assert.equal(isPublicInferenceAddress("2606:4700:4700::1111"), true)
  assert.equal(isPublicInferenceAddress("8.8.8.8"), true)
  for (const url of ["https://2130706433", "https://0x7f000001", "https://127.1", "http://public.test", "https://user:pass@public.test", "https://public.test?key=x", "https://public.test#x"]) {
    assert.throws(() => validateInferenceUrl(url, { base: true, allowedOrigins: new Set() }))
  }
  for (const value of ["*", "http://127.0.0.1:1234/path", "http://user@127.0.0.1:1234", "https://*.test", "http://127.0.0.1:1234?x=1"]) {
    assert.throws(() => inferenceEgressAllowedOrigins(value))
  }
  const allowed = inferenceEgressAllowedOrigins("http://127.0.0.1:1234")
  assert.equal(validateInferenceUrl("http://127.0.0.1:1234/v1", { allowedOrigins: allowed }).port, "1234")
  assert.throws(() => validateInferenceUrl("http://127.0.0.1:1235/v1", { allowedOrigins: allowed }))
})

test("relay is pull-driven and observer exceptions cannot truncate or consume extra bytes", async () => {
  let pulls = 0
  let completions = 0
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++
    if (pulls === 3) controller.close()
    else controller.enqueue(new Uint8Array([255, pulls]))
  } }, { highWaterMark: 0 })
  const body = trackStream(source, {
    chunk() { throw new Error("SECRET_MARKER") },
    done() { completions++; throw new Error("SECRET_MARKER") },
    fail() { assert.fail("Observer failure is not a transport failure") },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(pulls, 0)
  const reader = body.getReader()
  assert.deepEqual((await reader.read()).value, new Uint8Array([255, 1]))
  assert.equal(pulls, 1)
  assert.deepEqual((await reader.read()).value, new Uint8Array([255, 2]))
  assert.equal((await reader.read()).done, true)
  assert.equal(completions, 1)
})

test("cancellation aborts transport and finalizes exactly once even if its observer throws", async () => {
  let cancelled = 0
  let failures = 0
  const lifetime = upstreamLifetime(new AbortController().signal)
  const body = trackStream(new ReadableStream<Uint8Array>({ cancel() { cancelled++ } }), {
    chunk() {}, done() { assert.fail("not completed") }, fail() { failures++; throw new Error("SECRET_MARKER") },
  }, lifetime)
  await body.cancel()
  assert.equal(lifetime.signal.aborted, true)
  assert.equal(cancelled, 1)
  assert.equal(failures, 1)
})
