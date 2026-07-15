import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
)
const dataPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-data.tsx", import.meta.url),
)

describe("MCP OAuth callback migration UI contract", () => {
  test("offers a confirmed shared callback migration and explicit rollback", () => {
    const screen = readFileSync(screenPath, "utf8")
    const data = readFileSync(dataPath, "utf8")

    expect(screen).toContain("Callback update required")
    expect(screen).toContain("Copy the new shared callback")
    expect(screen).toContain("Add it to the external OAuth application")
    expect(screen).toContain("Reconnect using shared callback")
    expect(screen).toContain("I added the shared callback to the OAuth app")
    expect(screen).toContain("onClick={automaticCallbackMigrationPending ? onMigrateCallback : onConnect}")
    expect(screen).toContain("Revert to previous callback")
    expect(data).toContain("/oauth/use-shared-callback")
    expect(data).toContain("/oauth/revert-shared-callback")

    expect(data).not.toContain("oauthCallbackMode:")
  })

  test("edits requested scopes without forcing an immediate reconnect", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain("Requested OAuth scopes")
    expect(screen).toContain("requestedScopesText")
    expect(screen).toContain("Scope changes apply on next connect — reconnect to re-authorize.")
  })

  test("keeps deletion as a warned fallback instead of the primary migration path", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain("This can remove access grants, per-member authorization state, and plugin or marketplace bindings")
    expect(screen).toContain("Reconnecting with the shared callback is the safer migration path")
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
