import { describe, expect, test } from "bun:test"

import { parseMcpServersFromContent } from "../src/app/mcp"

describe("parseMcpServersFromContent", () => {
  test("normalizes string command + separate args into a command array", () => {
    // Exact repro shape from https://github.com/different-ai/openwork/issues/3372
    const content = JSON.stringify({
      mcp: {
        servers: {
          command: "python3",
          args: ["${OPENCODE_PLUGIN_ROOT}/mcp_servers/browser/server.py"],
          enabled: true,
          type: "local",
        },
      },
    })

    const entries = parseMcpServersFromContent(content)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe("servers")
    expect(entries[0]?.config.type).toBe("local")
    expect(entries[0]?.config.command).toEqual([
      "python3",
      "${OPENCODE_PLUGIN_ROOT}/mcp_servers/browser/server.py",
    ])
    expect("args" in (entries[0]?.config ?? {})).toBe(false)
  })

  test("keeps array-form command unchanged", () => {
    const content = JSON.stringify({
      mcp: {
        browser: {
          type: "local",
          command: [
            "python3",
            "${OPENCODE_PLUGIN_ROOT}/mcp_servers/browser/server.py",
          ],
          enabled: true,
        },
      },
    })

    const entries = parseMcpServersFromContent(content)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.config.command).toEqual([
      "python3",
      "${OPENCODE_PLUGIN_ROOT}/mcp_servers/browser/server.py",
    ])
  })

  test("string command with no args becomes a single-element array", () => {
    const content = JSON.stringify({
      mcp: {
        echo: {
          type: "local",
          command: "python3",
          enabled: true,
        },
      },
    })

    const entries = parseMcpServersFromContent(content)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.config.command).toEqual(["python3"])
    expect("args" in (entries[0]?.config ?? {})).toBe(false)
  })
})
