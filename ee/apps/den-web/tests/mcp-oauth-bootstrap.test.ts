import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
)

describe("pre-registered MCP OAuth bootstrap UI contract", () => {
  test("creates the connection before provider client credentials exist", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain("Client ID (optional for now)")
    expect(screen).toContain("keepOpenForRedirect")
    expect(screen).toContain("add credentials if your provider issued them")
    expect(screen).toContain("Add the pre-registered OAuth app")
    expect(screen).toContain("Callback URL — for pre-registered OAuth apps")
    expect(screen).toContain("providers such as Salesforce")
    expect(screen).toContain("Client metadata URL — for supported providers")
    expect(screen).toContain("They read the callback automatically")
    expect(screen).toContain("do not paste this into a callback URL field")
    expect(screen).toContain('aria-label="Copy callback URL"')
    expect(screen).toContain('aria-label="Copy client metadata URL"')
    expect(screen).not.toContain("oauthClientRequired && !oauthClientId.trim()")
  })

  test("discovers requirements automatically after the server URL settles", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain("MCP_REQUIREMENTS_DISCOVERY_DELAY_MS = 500")
    expect(screen).toContain("Checking server requirements…")
    expect(screen).toContain("discoveryRequestId.current !== requestId")
    expect(screen).toContain("window.setTimeout")
    expect(screen).toContain("window.clearTimeout")
    expect(screen).toContain("Retry")
    expect(screen).not.toContain("Discover requirements")
  })
})
