import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("native provider tool catalog UI", () => {
  test("shows a read-only tool catalog action for native provider rows", () => {
    const connectionsScreen = source("../app/(den)/dashboard/_components/your-connections-screen.tsx");
    const catalog = source("../app/(den)/dashboard/_components/mcp-tool-catalog.tsx");

    expect(connectionsScreen).toContain("const canViewTools = nativeProvider || canTestTools")
    expect(connectionsScreen).toContain("toggle-native-provider-tool-catalog")
    expect(connectionsScreen).toContain("<McpToolCatalog connection={connection} />")
    expect(catalog).toContain("Viewing this catalog does not run a tool")
    expect(catalog).toContain("Reconnect required")
    expect(catalog).not.toContain("useRunMcpConnectionTool")
    expect(catalog).not.toContain("Run tool")
  })

  test("keeps native and external catalogs on one normalized read contract", () => {
    const data = source("../app/(den)/dashboard/_components/mcp-connections-data.tsx");
    const catalog = source("../app/(den)/dashboard/_components/mcp-tool-catalog.tsx");

    expect(data).toContain("/v1/mcp-connections/${encodeURIComponent(connectionId)}/tools")
    expect(data).toContain('availability?: "available" | "connection_required" | "reconnect_required"')
    expect(catalog).toContain("useMcpConnectionTools(connection.id, true)")
  })
})
