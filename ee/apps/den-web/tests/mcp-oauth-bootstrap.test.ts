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
    expect(screen).toContain("add the client ID and secret before anyone connects")
    expect(screen).toContain("Add the pre-registered OAuth app")
    expect(screen).not.toContain("oauthClientRequired && !oauthClientId.trim()")
  })
})
