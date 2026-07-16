import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
)
const dataPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-data.tsx", import.meta.url),
)

describe("MCP OAuth callback compatibility UI contract", () => {
  test("keeps callback compatibility out of connection rows", () => {
    const screen = readFileSync(screenPath, "utf8")
    const data = readFileSync(dataPath, "utf8")

    expect(screen).toContain("onClick={onConnect}")
    expect(screen).not.toContain("Current callback:")
    expect(screen).not.toContain("Client metadata:")
    expect(screen).not.toContain("Callback update required")
    expect(screen).not.toContain("Reconnect using shared callback")
    expect(screen).not.toContain("Revert to previous callback")
    expect(data).not.toContain("/oauth/use-shared-callback")
    expect(data).not.toContain("/oauth/revert-shared-callback")
    expect(data).not.toContain("oauthMigrationStatus")
  })

  test("keeps connection rows focused on connect, disconnect, and a compact actions menu", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain('const canConnectOAuth = !needsAdminSetup && connection.authType === "oauth"')
    expect(screen).toContain('isPerMember ? !connection.connectedForMe : !connection.connected')
    expect(screen).toContain('aria-haspopup="menu"')
    expect(screen).toContain('role="menu"')
    expect(screen).toContain('More actions for ${connection.name}')
    expect(screen).toContain('{toolsOpen ? "Hide tools" : "View tools"}')
  })

  test("edits requested scopes without forcing an immediate reconnect", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain("Requested OAuth scopes")
    expect(screen).toContain("requestedScopesText")
    expect(screen).toContain("Scope changes apply on next connect — reconnect to re-authorize.")
  })

  test("warns before deleting a connection", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain("This can remove access grants, per-member authorization state, and plugin or marketplace bindings")
    expect(screen).toContain("window.confirm")
  })

  test("does not expose runtime selection to the normalized UI contract", () => {
    const screen = readFileSync(screenPath, "utf8")
    const data = readFileSync(dataPath, "utf8")

    expect(screen).not.toContain("DEN_ENABLE_ENTERPRISE_MCP_CLIENT")
    expect(data).not.toContain("DEN_ENABLE_ENTERPRISE_MCP_CLIENT")
    expect(data).not.toContain("enterpriseRuntime")
  })
})
