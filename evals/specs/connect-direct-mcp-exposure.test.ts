import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

const repoRoot = resolve(import.meta.dirname, "../..")

function runFiltered(filter: string, args: string[]): { status: number | null; output: string; error?: Error } {
  const result = spawnSync("pnpm", ["--filter", filter, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, error: result.error }
}

test("a Connect MCP connection marked exposeDirectly is served and projected as a standard MCP server", ({ evidence }) => {
  const gateway = runFiltered("@openwork-ee/den-api", [
    "exec",
    "bun",
    "test",
    "--conditions",
    "development",
    "test/external-connection-proxy.test.ts",
  ])
  expect(gateway.error, gateway.output).toBeUndefined()
  expect(gateway.status, gateway.output).toBe(0)
  expect(gateway.output).toContain("16 pass")
  expect(gateway.output).toContain("0 fail")

  const desktop = runFiltered("openwork-server", [
    "test",
    "src/connect-mcp-server-catalog.test.ts",
    "src/validators.test.ts",
  ])
  expect(desktop.error, desktop.output).toBeUndefined()
  expect(desktop.status, desktop.output).toBe(0)
  expect(desktop.output).toContain("0 fail")
  expect(desktop.output).toMatch(/Ran \d+ tests across 2 files/)

  evidence.recordAssertionEvidence(
    "Direct exposure serves the provider catalog to ordinary MCP clients",
    "With exposeDirectly set, the per-connection gateway lists the provider's model-visible tools (not search_capabilities/execute_capability), passes tool calls through, rejects App-only and tool-policy-blocked tools, and still hides resources.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Unflagged connections and the App host are unchanged",
    "Without the flag ordinary clients receive only the bounded search/execute pair, a forged App-host header cannot unlock the catalog, and an App-host client sees the same app-only surface whether or not the connection is exposed directly.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Direct exposure obeys the organization's member-facing MCP flag and fails closed",
    "With member-facing MCP connections disabled a flagged connection serves only the bounded pair and no downstream call happens; the request handler defaults to the bounded surface unless the route explicitly confirms the flag; the index selector returns no direct entries while the flag is off.",
    true,
  )
  evidence.recordAssertionEvidence(
    "The member index only advertises directly exposed connections to ordinary clients",
    "selectConnectMcpServerIndexConnections returns every ready connection to the App host and only exposeDirectly connections to other clients; index entries carry the flag.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Desktop projects exposed connections into the model runtime with the member credential",
    "reconcileOpenWorkConnectMcpServers writes an openwork-direct-<slug>-<digest> remote entry using the openwork-cloud member Authorization header (never the private App-host token), removes it when the flag is cleared or the index is unavailable, keeps legacy openwork-connect-* entries purged, preserves user MCPs, and validateUserMcpName reserves the openwork-direct- prefix.",
    true,
  )
})
