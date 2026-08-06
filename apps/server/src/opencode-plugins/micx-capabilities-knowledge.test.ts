import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { MicxCapabilitiesKnowledge } from "./micx-capabilities-knowledge.js";

describe("Micx capabilities knowledge plugin", () => {
  test("injects current Micx Connect guidance", async () => {
    const plugin = await MicxCapabilitiesKnowledge();
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
    expect(knowledge).toContain("opencode mcp auth micx");
    expect(knowledge).toContain("codex mcp login micx");
    expect(knowledge).toContain("search_capabilities");
    expect(knowledge).toContain("execute_capability");
    expect(knowledge).toContain("JWTs signed and validated with EdDSA");
    expect(knowledge).toContain("30-day inactivity window");
    expect(knowledge).toContain("reference_id");
    expect(knowledge).toContain("Micx documentation tools answer product questions. Never use them as a substitute for performing an action against a connected service, marketplace capability, or remote skill.");
    expect(knowledge).toContain("require the user to sign in to Micx first");
    expect(knowledge).toContain("Runtime steering from the Micx extensions plugin is the source of truth");
    expect(knowledge).toContain("retrieve the listed remote `create-skill` skill with its exact capability");
    expect(knowledge).toContain("Follow the separate runtime `Skill creation:` instruction");
    expect(knowledge).not.toContain("create custom skills in `.opencode/skills/`");
    expect(knowledge).not.toContain("First call `micx-cloud_search_capabilities`");
    expect(knowledge).not.toContain("then call `micx-cloud_execute_capability`");
    expect(knowledge).toContain("Settings > Extensions");
    expect(knowledge).toContain("Settings > Debug");
    expect(knowledge).toContain("custom or local MCP server");
    expect(knowledge).not.toContain("Access tokens are opaque");
    expect(knowledge).not.toContain("https://api.openworklabs.com/mcp`");
    expect(knowledge).not.toContain("micx-ui-mcp");
    expect(knowledge).not.toContain("micx_extensions_export");
  });

  test("retrieves Slack connection guidance from bundled docs", async () => {
    process.env.MICX_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await MicxCapabilitiesKnowledge();
    const search = await plugin.tool.micx_docs_search.execute({ query: "how can i connect slack", limit: 3 });

    expect(search).toContain("start-here/connect-your-stack/connect-slack-mcp.mdx");
    expect(search).toContain("Connect Slack as a custom MCP");

    const read = await plugin.tool.micx_docs_read.execute({
      path: "start-here/connect-your-stack/connect-slack-mcp.mdx",
    });

    expect(read).toContain("https://mcp.slack.com/mcp");
    expect(read).toContain("Advanced OAuth");
    expect(read).toContain("http://127.0.0.1:19876/mcp/oauth/callback");
    expect(read).toContain("search:read.public");
  });

  test("retrieves the Connect-first member flow from bundled docs", async () => {
    process.env.MICX_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await MicxCapabilitiesKnowledge();
    const search = await plugin.tool.micx_docs_search.execute({ query: "connect gmail calendar slack", limit: 3 });

    expect(search).toContain("start-here/connect-your-stack/connect-services.mdx");

    const read = await plugin.tool.micx_docs_read.execute({
      path: "start-here/connect-your-stack/connect-services.mdx",
    });

    expect(read).toContain("Settings` > `Micx Connect");
    expect(read).toContain("Needs your sign-in");
    expect(read).toContain("Ready to use");
    expect(read).toContain("advanced path for a custom or local server");
  });

  test("does not expose the retired local skill import guide", async () => {
    process.env.MICX_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await MicxCapabilitiesKnowledge();
    const search = await plugin.tool.micx_docs_search.execute({ query: "import a skill", limit: 10 });

    expect(search).not.toContain("start-here/do-work-with-it/import-a-skill.mdx");
  });

  test("reads current Cloud MCP endpoint and proxy guidance from bundled docs", async () => {
    process.env.MICX_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await MicxCapabilitiesKnowledge();
    const read = await plugin.tool.micx_docs_read.execute({
      path: "cloud/run-in-the-cloud/cloud-mcp.mdx",
    });

    expect(read).toContain("https://api.openworklabs.com/mcp/agent");
    expect(read).toContain("app.openworklabs.com/api/den");
    expect(read).toContain("internal same-origin desktop proxy");
    expect(read).toContain("OpenCode | Verified");
    expect(read).toContain("Codex | Setup only");
    expect(read).toContain("Cursor | Setup only");
    expect(read).toContain("opencode mcp logout micx");
    expect(read).toContain("codex mcp logout micx");
    expect(read).toContain("X-Request-Id");
    expect(read).toContain("reference_id");
    expect(read).toContain("JWTs signed and validated with EdDSA");
    expect(read).not.toContain("JWKS");
    expect(read).not.toContain("~/.cursor/mcp.json");
  });
});
