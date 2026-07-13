import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { OpenWorkCapabilitiesKnowledge } from "./openwork-capabilities-knowledge.js";

describe("OpenWork capabilities knowledge plugin", () => {
  test("injects current OpenWork Connect guidance", async () => {
    const plugin = await OpenWorkCapabilitiesKnowledge();
    const output = { system: [] };

    await plugin["experimental.chat.system.transform"]({}, output);

    const knowledge = output.system.join("\n");
    expect(knowledge).toContain("https://api.openworklabs.com/mcp/agent");
    expect(knowledge).toContain("app.openworklabs.com/api/den");
    expect(knowledge).toContain("internal same-origin desktop proxy");
    expect(knowledge).toContain("OpenCode is verified");
    expect(knowledge).toContain("Codex is setup-only");
    expect(knowledge).toContain("cursor://anysphere.cursor-mcp/oauth/callback");
    expect(knowledge).toContain("Settings > MCP servers");
    expect(knowledge).toContain("https://app.openworklabs.com/api/auth");
    expect(knowledge).toContain("RFC9728 discovery");
    expect(knowledge).toContain("PKCE S256");
    expect(knowledge).toContain("opencode mcp auth openwork");
    expect(knowledge).toContain("codex mcp login openwork");
    expect(knowledge).toContain("search_capabilities");
    expect(knowledge).toContain("execute_capability");
    expect(knowledge).toContain("JWTs signed and validated with EdDSA");
    expect(knowledge).toContain("30-day inactivity window");
    expect(knowledge).toContain("reference_id");
    expect(knowledge).not.toContain("Access tokens are opaque");
    expect(knowledge).not.toContain("https://api.openworklabs.com/mcp`");
    expect(knowledge).not.toContain("openwork-ui-mcp");
  });

  test("retrieves Slack connection guidance from bundled docs", async () => {
    process.env.OPENWORK_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await OpenWorkCapabilitiesKnowledge();
    const search = await plugin.tool.openwork_docs_search.execute({ query: "how can i connect slack", limit: 3 });

    expect(search).toContain("start-here/connect-your-stack/connect-slack-mcp.mdx");
    expect(search).toContain("Connect Slack MCP");

    const read = await plugin.tool.openwork_docs_read.execute({
      path: "start-here/connect-your-stack/connect-slack-mcp.mdx",
    });

    expect(read).toContain("https://mcp.slack.com/mcp");
    expect(read).toContain("Advanced OAuth");
    expect(read).toContain("http://127.0.0.1:19876/mcp/oauth/callback");
    expect(read).toContain("search:read.public");
  });

  test("reads current Cloud MCP endpoint and proxy guidance from bundled docs", async () => {
    process.env.OPENWORK_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await OpenWorkCapabilitiesKnowledge();
    const read = await plugin.tool.openwork_docs_read.execute({
      path: "cloud/run-in-the-cloud/cloud-mcp.mdx",
    });

    expect(read).toContain("https://api.openworklabs.com/mcp/agent");
    expect(read).toContain("app.openworklabs.com/api/den");
    expect(read).toContain("internal same-origin desktop proxy");
    expect(read).toContain("OpenCode | Verified");
    expect(read).toContain("Codex | Setup only");
    expect(read).toContain("Cursor | Setup only");
    expect(read).toContain("opencode mcp logout openwork");
    expect(read).toContain("codex mcp logout openwork");
    expect(read).toContain("X-Request-Id");
    expect(read).toContain("reference_id");
    expect(read).toContain("JWTs signed and validated with EdDSA");
    expect(read).not.toContain("JWKS");
    expect(read).not.toContain("~/.cursor/mcp.json");
  });
});
