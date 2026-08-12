import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { automationRuntimeKnowledge, OpenWorkCapabilitiesKnowledge } from "./openwork-capabilities-knowledge.js";

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
    expect(knowledge).toContain("OpenWork documentation tools answer product questions. Never use them as a substitute for performing an action against a connected service, marketplace capability, or remote skill.");
    expect(knowledge).toContain("require the user to sign in to OpenWork first");
    expect(knowledge).toContain("Runtime steering from the OpenWork extensions plugin is the source of truth");
    expect(knowledge).toContain("retrieve the listed remote `create-skill` skill with its exact capability");
    expect(knowledge).toContain("Follow the separate runtime `Skill creation:` instruction");
    expect(knowledge).not.toContain("create custom skills in `.opencode/skills/`");
    expect(knowledge).not.toContain("First call `openwork-cloud_search_capabilities`");
    expect(knowledge).not.toContain("then call `openwork-cloud_execute_capability`");
    expect(knowledge).toContain("Settings > Extensions");
    expect(knowledge).toContain("Settings > Debug");
    expect(knowledge).toContain("custom or local MCP server");
    expect(knowledge).not.toContain("Access tokens are opaque");
    expect(knowledge).not.toContain("https://api.openworklabs.com/mcp`");
    expect(knowledge).not.toContain("openwork-ui-mcp");
    expect(knowledge).not.toContain("openwork_extensions_export");
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

    expect(read).toContain("Settings` > `OpenWork Connect");
    expect(read).toContain("Needs your sign-in");
    expect(read).toContain("Ready to use");
    expect(read).toContain("advanced path for a custom or local server");
  });

  test("does not expose the retired local skill import guide", async () => {
    process.env.OPENWORK_DOCS_DIR = resolve(import.meta.dir, "../../../../packages/docs");

    const plugin = await OpenWorkCapabilitiesKnowledge();
    const search = await plugin.tool.openwork_docs_search.execute({ query: "import a skill", limit: 10 });

    expect(search).not.toContain("start-here/do-work-with-it/import-a-skill.mdx");
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

  test("teaches Automations as the product feature for recurring work", async () => {
    const plugin = await OpenWorkCapabilitiesKnowledge();
    const output = { system: [] };

    await plugin["experimental.chat.system.transform"]({}, output);

    const knowledge = output.system.join("\n");
    expect(knowledge).toContain("## Automations");
    expect(knowledge).toContain("openwork_execute");
    expect(knowledge).toContain("automation.propose");
    // Scheduling OpenWork work through the OS is the exact failure this guidance prevents.
    expect(knowledge).toContain("Never write a cron entry, launchd/systemd unit, Task Scheduler job");
    expect(knowledge).toContain("Desktop creation fixes placement to Desktop");
    // Reading and changing an existing Automation is a real capability, so the
    // guidance must name it rather than claim the agent cannot act at all.
    expect(knowledge).toContain("listAutomations");
    expect(knowledge).toContain("listAutomationRuns");
    expect(knowledge).toContain("updateAutomation");
    expect(knowledge).toContain("runAutomationNow");
    expect(knowledge).toContain("cancelAutomationRun");
    expect(knowledge).toContain("Only report schedules, status, next runs, or results from an actual capability call");
    expect(knowledge).toContain("Deactivation stops future runs but does not cancel a run already in progress");
    expect(knowledge).not.toContain("you cannot create, activate, or run an Automation");
    expect(knowledge).toContain("There is no interval schedule");
    expect(knowledge).toContain("signed-in desktop runner");
  });

  test("gives Cloud workers a Cloud-only creation contract", () => {
    const knowledge = automationRuntimeKnowledge("daytona");
    expect(knowledge).toContain("use createCloudAutomation");
    expect(knowledge).toContain("runs headlessly without a desktop");
    expect(knowledge).toContain("wake a stopped Cloud container");
    expect(knowledge).toContain("Do not use createAutomation or automation.propose from Cloud Chat");
  });
});
