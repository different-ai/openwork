import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const dataPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-data.tsx", import.meta.url),
)

describe("MCP OAuth callback compatibility data contract", () => {
  test("keeps callback migration endpoints out of the client", () => {
    const data = readFileSync(dataPath, "utf8")

    expect(data).not.toContain("/oauth/use-shared-callback")
    expect(data).not.toContain("/oauth/revert-shared-callback")
    expect(data).not.toContain("oauthMigrationStatus")
  })

  test("keeps issuer review available to the client", () => {
    const data = readFileSync(dataPath, "utf8")

    expect(data).toContain("/oauth/issuer-review")
    expect(data).toContain('action: "preview" | "confirm"')
  })

  test("does not expose runtime selection to the normalized UI contract", () => {
    const data = readFileSync(dataPath, "utf8")

    expect(data).not.toContain("DEN_ENABLE_ENTERPRISE_MCP_CLIENT")
    expect(data).not.toContain("enterpriseRuntime")
  })
})
