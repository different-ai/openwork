import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import { parseMcpServersFromContent, updateMcpEnabledInConfigContent } from "./mcp";

describe("mcp config helpers", () => {
  test("updates enabled without changing the MCP config shape", () => {
    const updated = updateMcpEnabledInConfigContent(
      `{
  // keep workspace comments
  "mcp": {
    "stripe": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {
        "x-team": "payments"
      }
    }
  }
}
`,
      "stripe",
      false,
    );

    expect(updated).toContain("// keep workspace comments");
    const parsed = parse(updated) as {
      mcp: { stripe: { type: string; url: string; enabled: boolean; headers: Record<string, string> } };
    };
    expect(parsed.mcp.stripe).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { "x-team": "payments" },
      enabled: false,
    });
  });

  test("parses paused MCP apps as configured entries", () => {
    const entries = parseMcpServersFromContent(
      JSON.stringify({
        mcp: {
          stripe: {
            type: "remote",
            url: "https://example.com/mcp",
            enabled: false,
          },
        },
      }),
    );

    expect(entries).toEqual([
      {
        name: "stripe",
        config: {
          type: "remote",
          url: "https://example.com/mcp",
          enabled: false,
        },
      },
    ]);
  });

  test("rejects unknown MCP app names", () => {
    expect(() =>
      updateMcpEnabledInConfigContent(
        JSON.stringify({
          mcp: {
            stripe: { type: "remote", url: "https://example.com/mcp" },
          },
        }),
        "linear",
        false,
      ),
    ).toThrow("MCP server not found");
  });

  test("pauses an inherited global MCP with a minimal workspace override", () => {
    const updated = updateMcpEnabledInConfigContent(
      "{}\n",
      "linear",
      false,
      {
        inheritedMcpServers: [
          {
            name: "linear",
            config: {
              type: "remote",
              url: "https://example.com/linear",
              headers: { Authorization: "Bearer secret" },
            },
          },
        ],
      },
    );

    const parsed = parse(updated) as { mcp: { linear: Record<string, unknown> } };
    expect(parsed.mcp.linear).toEqual({ enabled: false });
    expect(updated).not.toContain("example.com/linear");
    expect(updated).not.toContain("secret");
  });

  test("resumes an inherited global MCP by removing the workspace override", () => {
    const updated = updateMcpEnabledInConfigContent(
      JSON.stringify({
        mcp: {
          linear: { enabled: false },
          stripe: { type: "remote", url: "https://example.com/stripe" },
        },
      }),
      "linear",
      true,
      {
        inheritedMcpServers: [
          {
            name: "linear",
            config: {
              type: "remote",
              url: "https://example.com/linear",
            },
          },
        ],
      },
    );

    const parsed = parse(updated) as { mcp: Record<string, unknown> };
    expect(parsed.mcp.linear).toBeUndefined();
    expect(parsed.mcp.stripe).toEqual({ type: "remote", url: "https://example.com/stripe" });
  });

  test("does not write an override when inherited global MCP is already disabled", () => {
    const source = "{}\n";
    const updated = updateMcpEnabledInConfigContent(source, "linear", false, {
      inheritedMcpServers: [
        {
          name: "linear",
          config: {
            type: "remote",
            url: "https://example.com/linear",
            enabled: false,
          },
        },
      ],
    });

    expect(updated).toBe(source);
  });
});
