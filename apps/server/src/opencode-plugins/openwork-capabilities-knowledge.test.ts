import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { OpenWorkCapabilitiesKnowledge } from "./openwork-capabilities-knowledge.js";

describe("OpenWork capabilities knowledge plugin", () => {
  test("injects concise product-routing guidance instead of a product manual", async () => {
    const plugin = await OpenWorkCapabilitiesKnowledge();
    const output = { system: [] };

    await plugin["experimental.chat.system.transform"]({}, output);

    const knowledge = output.system.join("\n");
    expect(knowledge).toStartWith("# OpenWork product guidance");
    expect(knowledge).toContain("openwork_docs_search");
    expect(knowledge).toContain("openwork_docs_read");
    expect(knowledge).toContain("live runtime steering as the source of truth");
    expect(knowledge).toContain("Settings > Connect");
    expect(knowledge).toContain("custom or local MCP server");
    expect(knowledge).not.toContain("https://api.openworklabs.com");
    expect(knowledge).not.toContain("RFC9728");
    expect(knowledge).not.toContain("JWT");
    expect(knowledge.length).toBeLessThanOrEqual(700);
  });

  test("retrieves Slack connection guidance from bundled docs", async () => {
    process.env.OPENWORK_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await OpenWorkCapabilitiesKnowledge();
    const search = await plugin.tool.openwork_docs_search.execute({ query: "how can i connect slack", limit: 3 });

    expect(search).toContain("start-here/connect-your-stack/connect-slack-mcp.mdx");
    expect(search).toContain("Connect Slack as a custom MCP");

    const read = await plugin.tool.openwork_docs_read.execute({
      path: "start-here/connect-your-stack/connect-slack-mcp.mdx",
    });

    expect(read).toContain("https://mcp.slack.com/mcp");
    expect(read).toContain("Advanced OAuth");
    expect(read).toContain("http://127.0.0.1:19876/mcp/oauth/callback");
    expect(read).toContain("search:read.public");
  });

  test("retrieves the Connect-first member flow from bundled docs", async () => {
    process.env.OPENWORK_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await OpenWorkCapabilitiesKnowledge();
    const search = await plugin.tool.openwork_docs_search.execute({ query: "connect gmail calendar slack", limit: 3 });

    expect(search).toContain("start-here/connect-your-stack/connect-services.mdx");

    const read = await plugin.tool.openwork_docs_read.execute({
      path: "start-here/connect-your-stack/connect-services.mdx",
    });

    expect(read).toContain("Settings` > `Connect");
    expect(read).toContain("Needs your sign-in");
    expect(read).toContain("Ready to use");
    expect(read).toContain("advanced path for a custom or local server");
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
