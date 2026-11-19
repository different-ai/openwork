import assert from "node:assert/strict"
import { test } from "node:test"
import { DenUrlError, denRequest, isAllowedApiBaseUrl, normalizeBaseUrl, postPublic } from "./den.ts"

test("tokens only travel over HTTPS, or plain HTTP to a Den on this machine", () => {
  assert.equal(isAllowedApiBaseUrl("https://api.openworklabs.com"), true)
  assert.equal(isAllowedApiBaseUrl("http://127.0.0.1:8790"), true)
  assert.equal(isAllowedApiBaseUrl("http://localhost:8790"), true)
  assert.equal(isAllowedApiBaseUrl("http://[::1]:8790"), true)
  assert.equal(isAllowedApiBaseUrl("http://den.example.com"), false)
  assert.equal(isAllowedApiBaseUrl("http://127.0.0.1.example.com"), false)
  assert.equal(isAllowedApiBaseUrl("https://user:pass@den.example.com"), false)
  assert.equal(isAllowedApiBaseUrl("ftp://den.example.com"), false)
  assert.equal(isAllowedApiBaseUrl("not a url"), false)
})

test("refuses to send the session or start sign-in over plain HTTP to a remote host", async () => {
  let called = false
  const fetcher = async () => {
    called = true
    return new Response("{}")
  }
  await assert.rejects(denRequest(fetcher, { apiBaseUrl: "http://den.example.com", token: "t", orgId: null }, "/v1/me"), DenUrlError)
  await assert.rejects(postPublic(fetcher, "http://den.example.com", "/api/auth/device/code", {}), DenUrlError)
  assert.equal(called, false)
})

test("trims trailing slashes without a backtracking pattern", () => {
  assert.equal(normalizeBaseUrl(" https://den.example.com/// "), "https://den.example.com")
  assert.equal(normalizeBaseUrl("https://den.example.com"), "https://den.example.com")
  assert.equal(normalizeBaseUrl("/".repeat(100_000)), "")
})
