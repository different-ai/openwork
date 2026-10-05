import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord, records } from "../worlds/library.ts";
import { denCoworkMarketplaceWithConnections } from "../worlds/den-cowork-marketplace.ts";

const test = spec.world(denCoworkMarketplaceWithConnections, { timeout: 900_000, resources: { surfaces: [], services: ["den"] } });

// A reused Daytona Den keeps earlier runs' plugins; each run imports under its own name.
const PLUGIN_NAME = `Sales ${Date.now().toString(36)}`;
// The OAuth app Claude registered for its own Slack connector (fixture value).
const CLAUDE_SLACK_CLIENT_ID = "cowork-registered-client";
const CLAUDE_MICROSOFT_365_HOST = "microsoft365.mcp.claude.com";

type Use = { name: string; connection: string };

function uses(value: unknown): Use[] {
  return records(value).map((entry) => ({ name: String(entry.name), connection: String(entry.connection) }));
}

test("an admin migrating a Cowork plugin gets it wired to the Slack, Microsoft 365 and Google Workspace connections the organization already has", async ({ world, step, evidence }) => {
  const existingIds = new Set([...world.existing.slack, ...world.existing.microsoft365, ...world.existing.googleWorkspace].map((connection) => connection.id));
  const existingNames = (list: { name: string }[]) => list.map((connection) => connection.name);

  await step("given an organization that already connected Slack, Microsoft 365 and Google Workspace in OpenWork", async () => {
    evidence.recordAssertionEvidence(
      "existing connections",
      `Slack: ${existingNames(world.existing.slack).join(", ")}; Microsoft 365: ${existingNames(world.existing.microsoft365).join(", ")}; Google Workspace: ${existingNames(world.existing.googleWorkspace).join(", ")}`,
      world.existing.slack.length > 0 && world.existing.microsoft365.length > 0 && world.existing.googleWorkspace.length > 0,
    );
    expect(world.existing.slack.length).toBeGreaterThan(0);
  });

  await step("when the admin plans the migration, the plan says which existing connections the sales plugin will use", async () => {
    const run = await world.migrate(["plan"]);
    const result = isRecord(run.json) ? run.json : {};
    const sales = records(isRecord(records(result.marketplaces)[0]) ? records(result.marketplaces)[0].plugins : []).find((plugin) => plugin.name === "sales");
    const planned = uses(sales?.usesExisting);
    const message = typeof result.message === "string" ? result.message : run.stderr;
    const byName = new Map(planned.map((use) => [use.name, use.connection]));
    const ok = existingNames(world.existing.slack).includes(byName.get("slack") ?? "")
      && existingNames(world.existing.microsoft365).includes(byName.get("microsoft-365") ?? "")
      && existingNames(world.existing.googleWorkspace).includes(byName.get("gmail") ?? "");
    evidence.recordAssertionEvidence(
      "migrate plan",
      message.split("\n").filter((line) => line.includes("existing") || line.includes("sales")).join(" | ") || message.slice(0, 600),
      ok,
    );
    expect(run.code).toBe(0);
    expect(ok).toBe(true);
    expect(message).toContain("slack: will use your existing");
  });

  let connectionsBefore: Awaited<ReturnType<typeof world.connections>> = [];
  let pluginId = "";
  let item: Record<string, unknown> = {};

  await step("when the admin's agent imports the sales plugin", async () => {
    connectionsBefore = await world.connections();
    const { isError, json } = await world.callTool("execute_capability", {
      name: "postPluginsImportMcpsFromGithubUrl",
      body: { githubUrl: world.repoUrl("sales"), name: PLUGIN_NAME, access: { orgWide: true } },
    });
    item = isRecord(json) && isRecord(json.item) ? json.item : {};
    pluginId = isRecord(item.plugin) && typeof item.plugin.id === "string" ? item.plugin.id : "";
    evidence.recordAssertionEvidence(
      "import",
      isError ? `failed: ${JSON.stringify(json).slice(0, 600)}` : `mode ${String(item.mode)}; connectors: ${records(item.imported).map((entry) => String(entry.name)).join(", ")}`,
      !isError && Boolean(pluginId),
    );
    expect(isError).toBe(false);
    expect(pluginId).not.toBe("");
  });

  await step("then Slack is bound to the organization's Slack connection, not a new one", async () => {
    const slack = records(item.imported).find((entry) => entry.name === "slack");
    const ok = slack?.existingConnection === true && existingIds.has(String(slack.connectionId));
    evidence.recordAssertionEvidence("slack", `uses "${String(slack?.connectionName)}" (existing ${String(slack?.existingConnection)})`, ok);
    expect(ok).toBe(true);
  });

  await step("and Claude's Microsoft 365 and Gmail connectors use the organization's own connections instead of Anthropic-hosted ones", async () => {
    const skipped = records(item.skipped);
    const mapped = ["microsoft-365", "gmail"].map((name) => skipped.find((entry) => entry.name === name));
    const after = await world.connections();
    const added = after.filter((connection) => !connectionsBefore.some((earlier) => earlier.id === connection.id));
    const claudeHosted = after.filter((connection) => connection.url.includes(CLAUDE_MICROSOFT_365_HOST));
    const ok = mapped.every((entry) => entry?.reason === "native_connector" && isRecord(entry.reuse) && existingIds.has(String(entry.reuse.connectionId)))
      && claudeHosted.length === 0;
    evidence.recordAssertionEvidence(
      "microsoft-365 and gmail",
      `${mapped.map((entry) => `${String(entry?.name)} → ${isRecord(entry?.reuse) ? String(entry.reuse.connectionName) : "no existing connection"}`).join("; ")}; new connections: ${added.map((connection) => connection.name).join(", ") || "none"}; pointing at ${CLAUDE_MICROSOFT_365_HOST}: ${claudeHosted.length}`,
      ok,
    );
    expect(claudeHosted).toEqual([]);
    expect(ok).toBe(true);
  });

  await step("and Claude's own Slack app id is stored nowhere in the organization", async () => {
    const stored = `${await world.pluginComponentsText(pluginId)}\n${JSON.stringify(await world.connections())}`;
    const leaked = stored.includes(CLAUDE_SLACK_CLIENT_ID);
    evidence.recordAssertionEvidence("Claude's Slack client id", leaked ? "found in the stored plugin or connections" : `absent from ${stored.length} characters of stored plugin and connection data`, !leaked);
    expect(leaked).toBe(false);
  });

  await step("boundary: a connector OpenWork has no equivalent for (HubSpot) is still imported on its own", async () => {
    const hubspot = records(item.imported).find((entry) => entry.name === "hubspot");
    evidence.recordAssertionEvidence("hubspot", hubspot ? `${String(hubspot.url)} as "${String(hubspot.connectionName)}"` : "not imported", Boolean(hubspot));
    expect(String(hubspot?.url)).toBe("https://mcp.hubspot.com/anthropic");
  });
});
