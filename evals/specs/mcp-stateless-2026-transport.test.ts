import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

const repoRoot = resolve(import.meta.dirname, "../..")

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024,
  })
  return {
    error: result.error,
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  }
}

test("OpenWork Connect and the agent endpoint implement stateless MCP 2026", ({ evidence }) => {
  const connect = run("pnpm", ["--filter", "@openwork/enterprise-mcp-client", "test"])
  expect(connect.error, connect.output).toBeUndefined()
  expect(connect.status, connect.output).toBe(0)
  expect(connect.output).toContain("discovers a 2026 stateless server without an initialize handshake")
  expect(connect.output).toContain("negotiates the stateless protocol without initialize or a session id")
  expect(connect.output).toContain("does not downgrade the discovery probe after HTTP 401")
  expect(connect.output).toContain("keeps an administrator's selected scopes narrower than a scope-less provider advertisement")
  expect(connect.output).toContain("tests 77")
  expect(connect.output).toContain("fail 0")

  const agent = run("pnpm", [
    "--filter",
    "@openwork-ee/den-api",
    "exec",
    "bun",
    "test",
    "test/mcp-agent-stateless.test.ts",
  ])
  expect(agent.error, agent.output).toBeUndefined()
  expect(agent.status, agent.output).toBe(0)
  expect(agent.output).toContain("serves the 2026 stateless wire with fresh per-request servers")
  expect(agent.output).toContain("rejects a modern protocol header/body mismatch instead of normalizing it")
  expect(agent.output).toContain("keeps the 2025 stateless fallback for existing clients")
  expect(agent.output).toContain("delivers modern list changes through subscriptions/listen")
  expect(agent.output).toContain("4 pass")
  expect(agent.output).toContain("0 fail")

  evidence.recordAssertionEvidence(
    "OpenWork Connect negotiates the current stateless protocol",
    "The outbound client uses automatic SDK negotiation, reaches a 2026-07-28 server through server/discover without initialize or Mcp-Session-Id, and does not misclassify authorization or server failures as legacy-protocol signals.",
    true,
  )
  evidence.recordAssertionEvidence(
    "The public agent MCP is stateless on the modern wire",
    "The HTTP witness observes a fresh server for every server/discover, tools/list, and tools/call request; 2026 protocol, method, name, client, and capability metadata; and no request or response session identifier.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Compatibility and notification behavior remain explicit",
    "A 2025 SDK client completes initialize and tools/list without a session identifier, while a modern listener receives catalog changes through subscriptions/listen.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Protocol and authorization boundaries fail closed",
    "The server rejects a protocol header/body mismatch with JSON-RPC error -32020, and OAuth keeps an administrator-selected read scope narrower than a provider's broader advertisement.",
    true,
  )
})
