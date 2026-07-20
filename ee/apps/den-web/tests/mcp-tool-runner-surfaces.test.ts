import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const managedConnectionsPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
)
const yourConnectionsPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/your-connections-screen.tsx", import.meta.url),
)

describe("MCP tool runner surfaces", () => {
  test("keeps manual tool calling available from member and admin connection screens", () => {
    const managedConnections = readFileSync(managedConnectionsPath, "utf8")
    const yourConnections = readFileSync(yourConnectionsPath, "utf8")

    expect(managedConnections).toContain('import { McpToolRunner } from "./mcp-tool-runner"')
    expect(managedConnections).toContain("canRunTools={usableConnectionIds.has(connection.id) && connection.needsReconnect !== true}")
    expect(managedConnections).toContain('{toolRunnerOpen ? "Hide tool runner" : "Run a tool"}')
    expect(managedConnections).toContain("disabled={!canRunTools && !toolRunnerOpen}")
    expect(managedConnections).toContain("data-testid={`toggle-managed-mcp-tool-catalog-${connection.id}`}")
    expect(managedConnections).toContain("onRunTool={onToggleToolRunner}")
    expect(managedConnections).toContain("data-testid={`run-from-managed-mcp-tool-catalog-${connection.id}`}")
    expect(managedConnections).toContain("toolRunnerOpen && canRunTools ? <McpToolRunner connection={connection} />")

    expect(yourConnections).toContain('import { McpToolRunner } from "./mcp-tool-runner"')
    expect(yourConnections).toContain("toolRunnerOpen && canTestTools ? <McpToolRunner connection={connection} />")
  })
})
