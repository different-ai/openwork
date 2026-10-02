import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context } from "hono"
import { readAutoConfig } from "../src/free/shared/config.js"
import { resolveAnonymousClientAddress, trustedProxyMatcher } from "../src/free/guest/identity.js"

function request(socket: string, forwarded?: string) {
  return { env: { incoming: { socket: { remoteAddress: socket, remoteFamily: socket.includes(":") ? "IPv6" : "IPv4", remotePort: 443 } } },
    req: { header: (name: string) => name.toLowerCase() === "x-forwarded-for" ? forwarded : undefined } } as unknown as Context
}

test("trusted proxies accept exact addresses and CIDR ranges, and any malformed entry disables trust", () => {
  const match = trustedProxyMatcher(["10.0.0.0/8", "203.0.113.7", "fd00::/8"])
  assert.ok(match)
  assert.equal(match("10.214.3.9"), true)
  assert.equal(match("203.0.113.7"), true)
  assert.equal(match("fd12::1"), true)
  assert.equal(match("11.0.0.1"), false)
  assert.equal(match("203.0.113.8"), false)
  for (const bad of [["0.0.0.0/0"], ["10.0.0.0/7"], ["10.0.0.0/33"], ["not-an-ip"], ["10.0.0.0/8/1"], []]) {
    assert.equal(trustedProxyMatcher(bad), null, JSON.stringify(bad))
  }
})

test("behind a load balancer in a private range, each guest is counted by their own address, not the balancer's", () => {
  const config = { ...readAutoConfig({}), trustProxyHops: 1, trustedProxyIps: ["10.0.0.0/8"] }
  assert.equal(resolveAnonymousClientAddress(request("10.1.2.3", "198.51.100.20"), config), "198.51.100.20")
  assert.equal(resolveAnonymousClientAddress(request("10.9.9.9", "198.51.100.21"), config), "198.51.100.21")
  // A client-supplied header only counts when the hop in front of it is trusted.
  assert.equal(resolveAnonymousClientAddress(request("192.0.2.50", "198.51.100.20"), config), null)
  assert.equal(resolveAnonymousClientAddress(request("10.1.2.3"), config), null, "no forwarded address, no identity")
  // IPv6 clients share a /64 allowance.
  assert.equal(resolveAnonymousClientAddress(request("10.1.2.3", "2001:db8:1:2:3:4:5:6"), config), "2001:0db8:0001:0002::/64")
  // Without proxy trust the socket address is used, as before.
  assert.equal(resolveAnonymousClientAddress(request("198.51.100.30", "1.2.3.4"), readAutoConfig({})), "198.51.100.30")
})
