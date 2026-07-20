import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
)

describe("pre-registered MCP OAuth bootstrap UI contract", () => {
  test("links to deployment redirect guidance before the connection is created", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain("Client ID (optional for now)")
    expect(screen).toContain("Add the pre-registered OAuth app")
    expect(screen).toContain("OAuth setup")
    expect(screen).toContain("#oauth-redirect-url")
    expect(screen).toContain("Register this Den instance's redirect URL with the provider")
    expect(screen).not.toContain("keepOpenForRedirect")
    expect(screen).not.toContain("Finish OAuth setup")
    expect(screen).not.toContain("Create and show redirect URL")
    expect(screen).not.toContain('aria-label="Copy callback URL"')
    expect(screen).not.toContain('aria-label="Copy client metadata URL"')
    expect(screen).not.toContain("oauthClientRequired && !oauthClientId.trim()")
  })

  test("discovers requirements automatically after the server URL settles", () => {
    const screen = readFileSync(screenPath, "utf8")

    expect(screen).toContain("MCP_REQUIREMENTS_DISCOVERY_DELAY_MS = 500")
    expect(screen).toContain("Checking…")
    expect(screen).toContain("discoveryRequestId.current !== requestId")
    expect(screen).toContain("window.setTimeout")
    expect(screen).toContain("window.clearTimeout")
    expect(screen).toContain("Retry")
    expect(screen).not.toContain("Discover requirements")
    expect(screen).not.toContain("Detected automatically")
    expect(screen).not.toContain("Administrator action required")
    expect(screen).not.toContain("Tools require authentication")
  })
})
