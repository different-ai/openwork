import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { DynamicToolUIPart } from "ai"

import { Tool } from "../src/components/ui/tool"

test("renders compact MCP attribution in a failed chat tool row", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: "call-1",
    state: "output-error",
    input: {},
    errorText: JSON.stringify({
      error: "connection_failed",
      diagnostic: { code: "MCP_HTTP_504", httpStatus: 504 },
    }),
  }

  const html = renderToStaticMarkup(<Tool toolPart={toolPart} />)

  expect(html).toContain("Remote MCP · HTTP 504")
  expect(html).toContain("Error attribution: Remote MCP · HTTP 504. Confirmed.")
  expect(html).not.toContain(">failed<")
})

test("renders an inline reconnect button when Cloud capability discovery finds expired credentials", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_search_capabilities",
    toolCallId: "call-reconnect",
    state: "output-available",
    input: {},
    output: JSON.stringify({
      matches: [{
        kind: "connection_status",
        connectionStatus: {
          version: 1,
          kind: "connection_action",
          source: "openwork-cloud",
          connectionId: "emc_knowledge",
          connectionName: "Knowledge Hub",
          authType: "oauth",
          credentialMode: "per_member",
          state: "reauth_required",
          actor: "member",
          action: {
            type: "reconnect",
            surface: "openwork_your_connections",
            retry: "search_capabilities",
          },
        },
      }],
    }),
  }

  const html = renderToStaticMarkup(
    <Tool toolPart={toolPart} onReconnect={async () => "connected"} />,
  )

  expect(html).toContain("Reconnect required")
  expect(html).toContain('aria-label="Reconnect Knowledge Hub"')
  expect(html).toContain("Reconnect</button>")
  expect(html).toContain("bg-amber-3/60")
  expect(html).toContain('data-testid="chat-mcp-reconnect-action"')
})
