import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denManageAsAdmin } from "../worlds/den-library-manage.ts";
import { isRecord, records } from "../worlds/library.ts";

// Admins add a connector once in Manage and choose which teams get it.
const test = spec.world(denManageAsAdmin, { timeout: 600_000 });

const names = (items: { name: string }[]) => items.map((item) => item.name);

test("an admin adds a listed connector for two teams and an arbitrary MCP by URL", async ({ world, user, probe, step, evidence }) => {
  const reach = world.teamSize("Sales") + world.teamSize("Support");

  await step("1. I open Connectors in Manage: nothing is set up yet", async () => {
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 120_000 });
    await user.see({ text: "Apps your organization's AI can use. You choose who gets each one." });
    await user.see({ text: "Members can still add apps for themselves in My Library." });
    const links = await probe.eventually(() => world.sidebarLinks(), {
      within: 30_000, label: "admin sidebar", until: (labels) => labels.some((label) => label.startsWith("Connectors")),
    });
    for (const label of ["My Library", "Plugins", "Members"]) expect(links).toContain(label);
    expect(links).toContain("ConnectorsMCPs");
    const badges = (await probe.dom('[data-testid="den-org-sidebar"] a[href$="/mcp-connections"] span:last-child > span')).elements.map((badge) => badge.text);
    expect(badges).toContain("MCPs");
    evidence.recordAssertionEvidence("the Connectors sidebar item keeps its MCPs badge", `Sidebar links: ${links.join(", ")}; badge text: ${badges.join(", ")}`, true);
    await user.screenshot();
  });

  await step("the MCPs badge remains visible when Connectors is not selected", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/plugins`);
    await user.see({ role: "heading", label: "Plugins" }, { timeoutMs: 60_000 });
    expect((await probe.dom('[data-testid="den-org-sidebar"] a[href$="/mcp-connections"] span:last-child > span')).elements.map((badge) => badge.text)).toContain("MCPs");
    await user.screenshot();
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections`);
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 60_000 });
  });

  await step("2. I choose Add connector and pick Slack", async () => {
    await user.click({ role: "link", label: "Add connector" });
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 60_000 });
    await user.click({ role: "link", label: "Add Slack" });
    await user.see({ role: "heading", label: "Add Slack" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Sign in with Slack" }, { timeoutMs: 60_000 });
    expect(await world.servedPinnedCatalog(), "the catalog and checks came from the mock, not a real provider").toBe(true);
    await user.screenshot();
  });

  await step("3. I sign in with Slack once to try it", async () => {
    await user.click({ role: "button", label: "Sign in with Slack" });
    await user.see({ role: "heading", label: "Slack passed all 4 checks" }, { timeoutMs: 120_000 });
    const tab = await world.signInTab({ timeoutMs: 1_000 });
    if (tab?.client.targetId) await world.web.client.send("Target.closeTarget", { targetId: tab.client.targetId });
    await user.see({ role: "radio", label: /Each person signs in/ });
    const chosen = await probe.dom('input[name="sign-in-mode"][value="per_member"]:checked');
    expect(chosen.elements, "each person signs in is the default").toHaveLength(1);
    await user.screenshot();
  });

  await step("4. I let each person sign in and give it to Sales and Support", async () => {
    for (const team of ["Sales", "Support"]) {
      await user.click({ role: "button", label: "Add team" });
      await user.click({ role: "option", label: new RegExp(team) });
      await user.click({ role: "button", label: `Add ${team}` });
    }
    await user.see({ testId: "step-footer-note" }, { text: `${reach} people will find Slack in My Library.` });
    await user.screenshot();
  });

  await step("5. I add Slack and see who has it", async () => {
    await user.click({ role: "button", label: "Add Slack" });
    await user.see({ testId: "den-toast" }, { text: /Slack is ready/, timeoutMs: 60_000 });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`${reach} people will find it in My Library\\.`) });
    await user.see({ testId: "admin-connectors" }, { text: /Sales and Support/, timeoutMs: 60_000 });
    await user.screenshot();
  });

  await step("6. I open Slack: who can use it sits on the page instead of a Share button", async () => {
    await user.click({ role: "link", label: /^Slack/ });
    await user.see({ testId: "admin-connector-page" }, { timeoutMs: 60_000 });
    await user.see({ text: "Each person signs in with their own Slack account" });
    const teamRows = await probe.dom('[data-testid="access-team"]');
    expect(teamRows.elements.map((row) => /^(Sales|Support)/.exec(row.text)?.[1]).sort(), "both teams sit in Who can use it").toEqual(["Sales", "Support"]);
    await user.notSee({ role: "link", label: "Share" });
    await user.see({ role: "button", label: "Use in another app" });
    await user.screenshot();
  });

  await step("after: everyone in Sales and Support finds Slack in My Library and signs in as themselves, and Kai, who is in neither team, does not", async () => {
    for (const person of ["omar", "tess", "ana", "lee", "noor"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} has Slack`).toContain("Slack");
      const usable = await probe.api(world.den.members[person], "/v1/mcp-connections?scope=usable");
      const slack = isRecord(usable.body) ? records(usable.body.connections).find((entry) => entry.name === "Slack") : undefined;
      expect(slack?.credentialMode, `${person} signs in with their own account`).toBe("per_member");
    }
    expect(names(await world.library(world.den.members.kai)), "Kai is in neither team").not.toContain("Slack");
    await user.screenshot();
  });

  await step("before: the add page lists known connectors and keeps the MCPs sidebar badge", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/new`);
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 60_000 });
    await user.see({ role: "link", label: "Add HubSpot" });
    await user.see({ testId: "add-any-mcp" });
    await user.notSee({ role: "button", label: "Add another MCP" });
    const sidebar = await probe.dom('[data-testid="den-org-sidebar"]');
    expect(sidebar.elements[0]?.text).toContain("Connectors");
    expect(sidebar.elements[0]?.text).toContain("MCPs");
    await user.screenshot();
  });

  await step("the admin opens Add any MCP without entering advanced setup", async () => {
    await user.click({ testId: "add-any-mcp" });
    await user.see({ testId: "smart-add-query-input" }, { timeoutMs: 60_000 });
    await user.notSee({ role: "heading", label: "Add a custom MCP server" });
    await user.click({ role: "button", label: "Cancel" });
    await user.notSee({ testId: "add-mcp-connection-dialog" });
    await probe.eventually(() => world.location(), {
      within: 10_000, label: "the smart add URL flag to clear", until: (location) => location === "/dashboard/mcp-connections/all",
    });
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/new`);
    await user.click({ testId: "add-any-mcp" });
    await user.see({ testId: "smart-add-query-input" });
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
  });

  await step("when the admin pastes an unlisted MCP URL, the catalog offers custom add", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/new`);
    await user.type({ placeholder: "Search apps or paste MCP URL" }, world.custom.mcpUrl);
    await user.see({ testId: "connector-picker-no-match-add" }, { text: "Add this MCP" });
    evidence.recordAssertionEvidence("a pasted MCP URL is offered for adding", `Search "${world.custom.mcpUrl}" shows the "Add this MCP" action`, true);
    await user.screenshot();
  });

  await step("then the pasted URL is checked in the smart flow", async () => {
    await user.click({ testId: "connector-picker-no-match-add" });
    await user.see({ testId: "smart-add-query-input" }, { value: world.custom.mcpUrl, timeoutMs: 60_000 });
    await user.see({ testId: "smart-add-result-card" }, { timeoutMs: 60_000 });
    await user.see({ testId: "smart-add-submit" });
    await user.notSee({ role: "heading", label: "Add a custom MCP server" });
    await user.screenshot();
  });

  await step("after: the custom MCP is available to members without widening Slack access", async () => {
    await user.click({ testId: "smart-add-submit" });
    await probe.eventually(async () => {
      await user.notSee({ testId: "add-mcp-connection-dialog" });
      return true;
    }, { within: 60_000, label: "the custom MCP dialog to close after saving" });
    await probe.eventually(() => world.location(), {
      within: 10_000, label: "the saved connection URL flag to clear", until: (location) => location === "/dashboard/mcp-connections/all",
    });
    const custom = await probe.eventually(async () => {
      const manageable = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
      return isRecord(manageable.body) ? records(manageable.body.connections).find((entry) => entry.url === world.custom.mcpUrl) : undefined;
    }, { within: 60_000, label: "the custom MCP to be saved" });
    expect(custom?.name).toEqual(expect.any(String));
    await probe.eventually(async () => names(await world.library(world.den.members.kai)).includes(String(custom?.name)), {
      within: 60_000, label: "the custom MCP to become available to Kai",
    });
    const kaiLibrary = names(await world.library(world.den.members.kai));
    expect(kaiLibrary).not.toContain("Slack");
    evidence.recordAssertionEvidence("the custom MCP is saved and reaches members without widening Slack", `Saved "${String(custom?.name)}" at ${world.custom.mcpUrl}; Kai's Library: ${kaiLibrary.join(", ")}`, true);
    await user.screenshot();
  });
});
