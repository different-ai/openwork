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
