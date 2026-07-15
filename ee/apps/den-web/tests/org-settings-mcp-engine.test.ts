import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const screen = readFileSync(fileURLToPath(
  new URL("../app/(den)/dashboard/_components/org-settings-screen.tsx", import.meta.url),
), "utf8")
const provider = readFileSync(fileURLToPath(
  new URL("../app/(den)/dashboard/_providers/org-dashboard-provider.tsx", import.meta.url),
), "utf8")
const denOrg = readFileSync(fileURLToPath(
  new URL("../app/(den)/_lib/den-org.ts", import.meta.url),
), "utf8")

describe("MCP OAuth engine organization setting", () => {
  test("shows the safe rollout choices and can clear an org override", () => {
    expect(screen).toContain("MCP OAuth engine")
    expect(screen).toContain("Follow deployment default")
    expect(screen).toContain("Previous flow")
    expect(screen).toContain("Hardened client (new)")
    expect(screen).toContain("(deployment default)")
    expect(screen).toContain('externalMcpEngineChoice === "default" ? null : externalMcpEngineChoice')
    expect(provider).toContain("body.externalMcpEngine = input.externalMcpEngine")
    expect(denOrg).toContain('externalMcpEngine: { effective: "legacy", source: "default" }')
  })

  test("never exposes the deployment environment variable name", () => {
    expect(screen).not.toContain("DEN_ENABLE_ENTERPRISE_MCP_CLIENT")
    expect(provider).not.toContain("DEN_ENABLE_ENTERPRISE_MCP_CLIENT")
    expect(denOrg).not.toContain("DEN_ENABLE_ENTERPRISE_MCP_CLIENT")
  })
})
