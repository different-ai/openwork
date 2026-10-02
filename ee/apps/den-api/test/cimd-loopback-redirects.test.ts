import { expect, test } from "bun:test"
import { relaxLoopbackRedirectUris } from "../src/mcp/cimd-loopback-redirects.js"

const registered = ["http://localhost/callback", "http://127.0.0.1/callback", "https://client.example.test/oauth/callback"]

test("accepts any port on a registered loopback redirect (RFC 8252 §7.3), including localhost", () => {
  expect(relaxLoopbackRedirectUris(registered, "http://localhost:51234/callback")).toContain("http://localhost:51234/callback")
  expect(relaxLoopbackRedirectUris(registered, "http://127.0.0.1:8080/callback")).toContain("http://127.0.0.1:8080/callback")
  expect(relaxLoopbackRedirectUris(["http://[::1]:3000/cb"], "http://[::1]:4000/cb")).toContain("http://[::1]:4000/cb")
})

test("keeps exact matching for everything else", () => {
  expect(relaxLoopbackRedirectUris(registered, "http://localhost:51234/other")).toEqual(registered)
  expect(relaxLoopbackRedirectUris(registered, "http://127.0.0.1:51234/callback?x=1")).toEqual(registered)
  expect(relaxLoopbackRedirectUris(registered, "https://localhost:51234/callback")).toEqual(registered)
  expect(relaxLoopbackRedirectUris(registered, "http://localhost.attacker.test:51234/callback")).toEqual(registered)
  expect(relaxLoopbackRedirectUris(registered, "https://client.example.test:8443/oauth/callback")).toEqual(registered)
  expect(relaxLoopbackRedirectUris(registered, "http://localhost:1/callback#frag")).toEqual(registered)
  expect(relaxLoopbackRedirectUris(["https://client.example.test/oauth/callback"], "http://localhost:51234/callback")).toEqual(["https://client.example.test/oauth/callback"])
})

test("does not cross loopback hosts and leaves exact matches alone", () => {
  expect(relaxLoopbackRedirectUris(["http://127.0.0.1/callback"], "http://localhost:51234/callback")).toEqual(["http://127.0.0.1/callback"])
  expect(relaxLoopbackRedirectUris(registered, "http://localhost/callback")).toEqual(registered)
  expect(relaxLoopbackRedirectUris(undefined, "http://localhost:1/callback")).toEqual([])
  expect(relaxLoopbackRedirectUris(registered, "not a url")).toEqual(registered)
})
