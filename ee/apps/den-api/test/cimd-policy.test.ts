import { afterAll, expect, mock, test } from "bun:test"

// Deployment policy for Client ID Metadata Document URLs: which client_id URLs
// Den is willing to fetch before the cimd plugin resolves them.
const envState = {
  betterAuthUrl: "https://app.den.example.test",
  apiPublicUrl: "https://api.den.example.test",
  corsOrigins: ["https://app.den.example.test", "https://console.den.example.test", "*"],
  allowPrivateMcpUrls: false,
}

mock.module("../src/env.js", () => ({ env: envState }))

const { isCimdClientIdUrlAllowed } = await import("../src/mcp/cimd-policy.js")

afterAll(() => {
  mock.restore()
})

test("rejects anything that is not an HTTPS URL", async () => {
  expect(await isCimdClientIdUrlAllowed("not a url")).toBe(false)
  expect(await isCimdClientIdUrlAllowed("http://client.example.test/oauth/client-metadata.json")).toBe(false)
})

test("never fetches a document hosted on one of Den's own origins", async () => {
  for (const origin of ["https://app.den.example.test", "https://api.den.example.test", "https://console.den.example.test"]) {
    expect(await isCimdClientIdUrlAllowed(`${origin}/oauth/client-metadata.json`)).toBe(false)
  }
  // Same host, different origin (port) is a different server and stays eligible for the DNS check.
  expect(await isCimdClientIdUrlAllowed("https://client.example.test:8443/oauth/client-metadata.json")).not.toBe(undefined)
})

test("hosted deployments require the hostname to resolve to public addresses", async () => {
  // localhost resolves to a loopback address, which the DNS guard rejects.
  expect(await isCimdClientIdUrlAllowed("https://localhost/oauth/client-metadata.json")).toBe(false)
  expect(await isCimdClientIdUrlAllowed("https://10.0.0.8/oauth/client-metadata.json")).toBe(false)
})

test("private deployments skip the DNS guard but keep the self-origin denial", async () => {
  envState.allowPrivateMcpUrls = true
  try {
    expect(await isCimdClientIdUrlAllowed("https://localhost/oauth/client-metadata.json")).toBe(true)
    expect(await isCimdClientIdUrlAllowed("https://api.den.example.test/oauth/client-metadata.json")).toBe(false)
  } finally {
    envState.allowPrivateMcpUrls = false
  }
})
