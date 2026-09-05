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
    expect(knowledge).toContain("search_capabilities");
    expect(knowledge).toContain("execute_capability");
    // Protocol and client-setup detail lives in the docs, reachable through
    // openwork_docs_read with a docs-relative path — the always-on prompt only
    // routes to it. Keeping OAuth mechanics out of every request saves ~2.5k
    // characters per turn.
    expect(knowledge).toContain("read cloud/run-in-the-cloud/cloud-mcp.mdx with openwork_docs_read");
    expect(knowledge).toContain("read cloud/share-with-your-team/desktop-policies.mdx");
    expect(knowledge).not.toContain("packages/docs/");
    expect(knowledge).not.toContain("cursor://anysphere.cursor-mcp/oauth/callback");
    expect(knowledge).not.toContain("RFC9728 discovery");
    expect(knowledge).not.toContain("JWTs signed and validated with EdDSA");
    expect(knowledge).not.toContain("30-day inactivity window");
    expect(knowledge).not.toContain("codex mcp login openwork");
    expect(knowledge).toContain("OpenWork documentation tools answer product questions. Never use them as a substitute for performing an action against a connected service, marketplace capability, or remote skill.");
    expect(knowledge).toContain("Settings > Library");
    expect(knowledge).toContain("Settings > Debug");
    expect(knowledge).toContain("custom or local MCP server");
    expect(knowledge).not.toContain("Access tokens are opaque");
    expect(knowledge).not.toContain("https://api.openworklabs.com/mcp`");
    expect(knowledge).not.toContain("openwork-ui-mcp");
    expect(knowledge).not.toContain("openwork_extensions_export");
  });

  test("states each rule once and never describes removed or duplicated guidance", async () => {
    const plugin = await OpenWorkCapabilitiesKnowledge();
    const output = { system: [] };

    await plugin["experimental.chat.system.transform"]({}, output);

    const knowledge = output.system.join("\n");
    // Den removed the Memory Bank; cross-chat memory is session history only,
    // read through session.search/session.read without navigating the user.
    expect(knowledge).not.toContain("Memory Bank");
    expect(knowledge).toContain("## Other sessions");
    expect(knowledge).toContain("use the session affordances described under OpenWork app context");
    expect(knowledge).not.toContain("session.search then session.read");
    expect(knowledge).not.toContain("open the matching session");
    // Owned elsewhere: Connect tool mechanics (base prompt), readiness and
    // sign-in direction (runtime steering), skill-authoring mode (steering),
    // browser and app-control mechanics (extensions plugin), and the
    // Automation listing's read-live rule (catalog section).
    expect(knowledge).not.toContain("openwork-cloud_search_capabilities");
    expect(knowledge).not.toContain("require the user to sign in to OpenWork first");
    expect(knowledge).not.toContain("source of truth for whether Cloud execution tools");
    expect(knowledge).not.toContain("retrieve the listed remote `create-skill` skill");
    expect(knowledge).not.toContain("NOT browser tools");
    expect(knowledge).not.toContain("Only report schedules, status, next runs, or results from an actual capability call");
    expect(knowledge).not.toContain("Important docs to know");
    expect(knowledge).toContain("Create them as the `Skill creation:` instruction in this prompt directs.");
    expect(knowledge).toContain("use the user's time zone stated in this prompt");
    expect(knowledge).toContain("Deactivation stops future runs but does not cancel a run already in progress.");
  });

  test("extends the engine system entry instead of adding a second system message", async () => {
    const plugin = await OpenWorkCapabilitiesKnowledge();
    const output = { system: ["engine header"] };

    await plugin["experimental.chat.system.transform"]({}, output);

    expect(output.system).toHaveLength(1);
    expect(output.system[0].startsWith("engine header\n\nYou are running inside OpenWork.")).toBe(true);
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
    // "Read live before reporting" is owned by the Automation catalog section
    // that accompanies the listing; the knowledge block does not restate it.
    expect(knowledge).not.toContain("from an actual capability call");
    expect(knowledge).toContain("Deactivation stops future runs but does not cancel a run already in progress");
    expect(knowledge).not.toContain("you cannot create, activate, or run an Automation");
    expect(knowledge).toContain("there is no interval schedule");
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
