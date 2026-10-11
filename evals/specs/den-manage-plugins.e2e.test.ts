import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord, records } from "../worlds/library.ts";
import { denManagePluginsAsAdmin, denManageIntegratedPluginsAsAdmin } from "../worlds/den-library-manage.ts";

// Admins build a plugin once in Manage and choose which teams get it.
const test = spec.world(denManagePluginsAsAdmin, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });
const integratedTest = spec.world(denManageIntegratedPluginsAsAdmin, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });

const names = (items: { name: string }[]) => items.map((item) => item.name);

test("an admin: I want to give the Sales team a plugin so they all get the same skills", async ({ world, user, probe, step, evidence }) => {
  const reach = world.teamSize("Sales");
  let directoryUrl = "";

  await step("1. I open Plugins in Manage: there are none yet", async () => {
    await user.see({ testId: "plugins-empty" }, { timeoutMs: 120_000 });
    await user.see({ text: "Skills, commands and connectors bundled for a job. You choose which teams get each one." });
    await user.see({ text: "Members can still make plugins for themselves in My Library." });
    await user.notSee({ text: "GitHub" });
    await user.screenshot();
  });

  await step("before: an empty My Library keeps its original invitation and add picker", async () => {
    if (!world.memberWeb) throw new Error("The empty member Library was not arranged.");
    const member = user.on(world.memberWeb);
    await member.see({ testId: "library-empty" }, { timeoutMs: 60_000 });
    await member.screenshot();
    await member.click({ role: "button", label: "Add to your Library" });
    await member.see({ testId: "library-add-dialog" });
    await member.screenshot();
    await member.click({ role: "button", label: "Cancel" });
    evidence.recordAssertionEvidence("the off Library keeps the original empty and add states", "Nothing in your Library yet and Add to your Library remain unchanged while the rollout is off", true);
  });

  await step("2. I create a plugin with the skill every sales call needs", async () => {
    await user.click({ role: "link", label: "Create a plugin" });
    await user.see({ testId: "plugin-create-form" }, { timeoutMs: 60_000 });
    await user.see({ text: "Nobody else gets it until you choose who can use it." });
    await user.type({ placeholder: "Sales call prep" }, "Sales call prep");
    await user.type({ placeholder: "What it helps people do" }, "Get ready for a sales call");
    await user.click({ role: "button", label: /^Skill$/ });
    await user.type({ role: "textbox", label: "Skill name" }, "Prep a sales call");
    await user.type({ role: "textbox", label: "When to use it" }, "Before any call with a customer");
    await user.type({ role: "textbox", label: "Skill steps" }, "Read the account notes, then list three questions to ask.");
    await user.screenshot();
  });

  await step("3. I create it: only I have it so far", async () => {
    await user.click({ role: "button", label: "Create plugin" });
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.see({ role: "heading", label: "Sales call prep" });
    await user.see({ text: "Off. Only you have it so far." });
    await user.see({ testId: "whats-inside" }, { text: /Prep a sales call/ });
    await user.notSee({ role: "link", label: "Share" });
    await user.screenshot();
  });

  await step("4. I choose Add team and pick Sales", async () => {
    await user.click({ role: "button", label: "Add team" });
    await user.see({ placeholder: "Search teams" });
    await user.click({ role: "option", label: /Sales/ });
    await user.see({ text: "1 team selected" });
    await user.screenshot();
  });

  await step("5. I add Sales and they can use it right away", async () => {
    await user.click({ role: "button", label: "Add Sales" });
    await user.see({ testId: "den-toast" }, { text: /Sales can use it now/, timeoutMs: 60_000 });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`${reach} people will find it in My Library\\.`) });
    await user.see({ testId: "access-team" }, { text: /Sales/ });
    await user.screenshot();
  });

  await step("6. I go back to Plugins and see who has it", async () => {
    const logStart = (await world.proxy.requestLog()).length;
    await user.click({ role: "link", label: "Plugins" });
    await user.see({ testId: "admin-plugins" }, { timeoutMs: 60_000 });
    await user.see({ testId: "admin-plugins" }, { text: /Sales call prep/ });
    const status = await probe.eventually(async () => (await probe.dom('[data-plugin-row="Sales call prep"] [data-item-status]')).elements[0]?.text ?? "", {
      within: 30_000, label: "who has the plugin", until: (text) => text === "Sales",
    });
    expect(status).toBe("Sales");
    const listCalls = (await world.proxy.requestLog()).slice(logStart).map((entry) => entry.path)
      .filter((path) => path.startsWith("/v1/plugins?") || /^\/v1\/plugins\/[^/?]+\/access/.test(path));
    expect(listCalls, "the directory fetches a bounded page with access").toContain("/v1/plugins?status=active&limit=50&includeAccess=true&includeTotal=true&includeFacets=true");
    expect(listCalls.some((path) => /\/access/.test(path))).toBe(false);
    evidence.recordAssertionEvidence(
      "Plugins loads a bounded page with access",
      `The Sales call prep row reads "${status}"; directory requests Den received: ${listCalls.join(", ")}`,
      true,
    );
    await user.screenshot();
  });

  await step("after: I find the plugin by name and by Sales access", async () => {
    await user.type({ placeholder: "Search plugins by name" }, "Sales call");
    await user.see({ testId: "admin-plugins" }, { text: /Sales call prep/ });
    await user.see({ testId: "plugin-directory-columns" }, { text: /Name[\s\S]*Shared with[\s\S]*Owner[\s\S]*Updated/ });
    await user.click({ role: "button", label: "Team" });
    await user.see({ text: "Plugins available to a team" });
    await user.screenshot();
    await user.click({ role: "button", label: "Sales" });
    await user.see({ role: "button", label: /Team: Sales/ });
    await user.see({ text: "1 plugin" });
    await user.see({ testId: "admin-plugins" }, { text: /Sales call prep/ });
    directoryUrl = new URL(await world.location(), world.den.ref.webUrl).toString();
    await user.screenshot();
  });

  await step("the matching plugin still opens its details", async () => {
    await user.click({ role: "link", label: /Sales call prep/ });
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.see({ role: "heading", label: "Sales call prep" });
    await user.screenshot();
    await user.navigate(directoryUrl);
    await user.see({ testId: "admin-plugins" });
    await user.see({ role: "button", label: /Team: Sales/ });
    expect(await world.location()).toContain(`name=Sales+call&teamId=${world.teamIds.Sales}`);
    await user.screenshot();
  });

  await step("Owner filters the creator, not a person who was given access", async () => {
    expect(names(await world.library(world.den.members.omar))).toContain("Sales call prep");
    await user.click({ role: "button", label: "Owner" });
    await user.see({ text: "Plugins created by" });
    await user.screenshot();
    await user.click({ role: "button", label: "Omar Diaz" });
    await user.see({ text: "No plugins match. Try another name, team, or owner." });
    await user.screenshot();
    await user.click({ role: "button", label: /Owner: Omar Diaz/ });
    await user.click({ role: "button", label: "Riley Admin" });
    await user.see({ testId: "admin-plugins" }, { text: /Sales call prep/ });
    await user.see({ testId: "plugin-directory-total" }, { text: "1" });
    await user.reload();
    await user.see({ role: "button", label: /Owner: Riley Admin/ });
    await user.see({ role: "button", label: /Team: Sales/ });
    const inventory = await probe.api(world.den.admin, `/v1/plugins?status=active&includeTotal=true&includeFacets=true&teamId=${world.teamIds.Sales}`);
    if (!isRecord(inventory.body)) throw new Error("Plugin inventory is missing.");
    expect(inventory.body.total).toBe(1);
    expect(records(inventory.body.teamCounts).find((entry) => entry.id === world.teamIds.Sales)?.count).toBe(1);
    expect(records(inventory.body.ownerCounts).find((entry) => entry.id === world.memberIds.omar)).toBeUndefined();
    const matching = records(inventory.body.items)[0];
    expect(records(inventory.body.ownerCounts)).toContainEqual({ id: matching?.createdByOrgMembershipId, count: 1 });
    const filteredPaths = (await world.proxy.requestLog()).map((entry) => entry.path).filter((path) => path.startsWith("/v1/plugins?"));
    expect(filteredPaths.some((path) => path.includes(`ownerId=${world.memberIds.omar}`))).toBe(true);
    evidence.recordAssertionEvidence("owner and team filters have distinct meanings", "Omar can use the Sales plugin but does not own it; selecting Omar as owner gives zero results. Selecting Riley and Sales gives one result after reload. Team and owner counts agree with persisted grants and creator.", true);
    await user.screenshot();
  });

  await step("before: Members, Connectors and Settings provide the surrounding Den design", async () => {
    for (const path of ["members", "mcp-connections", "org-settings"]) {
      await user.navigate(`${world.den.ref.webUrl}/dashboard/${path}`);
      await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
      await user.screenshot();
    }
    evidence.recordAssertionEvidence("Den reference screens remain available", "Members, Connectors and Settings opened in the same organization", true);
  });

  await step("after: Omar and Tess in Sales find Sales call prep in My Library, and Kai, who is outside Sales, does not", async () => {
    for (const person of ["omar", "tess"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} has the plugin`).toContain("Sales call prep");
    }
    expect(names(await world.library(world.den.members.kai)), "Kai is outside Sales").not.toContain("Sales call prep");
    await user.screenshot();
  });

  await step("before: My Library keeps its separate Kind and sharing lanes and its original add picker", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/library`);
    await user.see({ testId: "library-screen" }, { timeoutMs: 60_000 });
    await user.see({ text: "Sales call prep" });
    expect((await probe.dom("[data-library-integrated-row]")).elements).toHaveLength(0);
    await user.screenshot();
    await user.click({ role: "button", label: "Add to your Library" });
    await user.see({ testId: "library-add-dialog" });
    await user.screenshot();
    evidence.recordAssertionEvidence("the off Library retains its original rows and picker", "Sales call prep is present; no integrated row; Add to your Library opens the original picker", true);
  });
});

integratedTest("an owner uses an integrated Library without changing who can manage its plugins", async ({ world, user, probe, step, evidence }) => {
  if (!world.memberWeb) throw new Error("The read-only member browser was not arranged.");
  const member = user.on(world.memberWeb);
  const memberProbe = probe.on(world.memberWeb);
  const base = world.den.ref.webUrl;
  let pluginId = "";

  await step("after: the empty Plugins collection has one create action, no counts or wide search", async () => {
    await user.see({ testId: "plugins-empty" }, { timeoutMs: 90_000 });
    await user.see({ text: "Only you can use it until you choose who gets access." });
    expect((await probe.dom('a[href$="/plugins/new"]')).elements.filter((item) => item.text.includes("Create a plugin"))).toHaveLength(1);
    expect((await probe.dom('[data-testid="plugin-directory-total"], [data-testid="plugin-directory-columns"]')).elements).toHaveLength(0);
    const context = await probe.api(world.den.admin, "/v1/org");
    expect(isRecord(context.body) && isRecord(context.body.features) && context.body.features.libraryIntegrated).toBe(true);
    evidence.recordAssertionEvidence("only the presentation rollout is enabled", "libraryIntegrated=true; empty collection has one Create a plugin action and no directory count or column labels", true);
    await user.screenshot();
  });

  await step("after: a member's empty My Library offers one add flow", async () => {
    await member.see({ testId: "library-empty" }, { timeoutMs: 60_000 });
    expect((await memberProbe.dom('[data-testid="library-screen"] button')).elements.filter((item) => item.text === "Add to library")).toHaveLength(1);
    await member.screenshot();
    await member.click({ role: "button", label: "Add to library" });
    await member.see({ testId: "library-add-dialog" });
    await member.see({ role: "radio", label: /^Skill/ });
    await member.screenshot();
    await member.click({ role: "button", label: "Cancel" });
    evidence.recordAssertionEvidence("the empty Library has one door into adding", "One Add to library action opens the same Connector, Skill and Plugin picker", true);
  });

  await step("after: the owner creates the same plugin and skill through the existing form", async () => {
    await user.click({ role: "link", label: "Create a plugin" });
    await user.see({ testId: "plugin-create-form" });
    await user.type({ placeholder: "Sales call prep" }, "Sales call prep");
    await user.type({ placeholder: "What it helps people do" }, "Get ready for a sales call");
    await user.click({ role: "button", label: /^Skill$/ });
    await user.type({ role: "textbox", label: "Skill name" }, "Prep a sales call");
    await user.type({ role: "textbox", label: "When to use it" }, "Before a sales call");
    await user.type({ role: "textbox", label: "Skill steps" }, "Read the account notes, then list three questions to ask.");
    await user.screenshot();
    await user.click({ role: "button", label: "Create plugin" });
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.see({ testId: "whats-inside" }, { text: /Prep a sales call/ });
    await user.see({ text: "Off. Only you have it so far." });
    const directory = await probe.api(world.den.admin, "/v1/plugins?status=active&limit=50");
    if (!isRecord(directory.body)) throw new Error("No plugin directory.");
    const created = records(directory.body.items).find((item) => item.name === "Sales call prep");
    if (typeof created?.id !== "string") throw new Error("The created plugin is missing.");
    pluginId = created.id;
    expect((await probe.dom("[data-library-integrated-header]")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("the plugin remains private after creation", `Created ${pluginId}; existing skill is present and Who can use it still says Only you`, true);
    await user.screenshot();
  });

  await step("after: plugin and skill detail use the same compact header and flat content structure", async () => {
    await user.click({ role: "button", label: "More for Sales call prep" });
    await user.click({ role: "menuitem", label: "Edit contents" });
    await user.see({ role: "link", label: /prep-a-sales-call|Prep a sales call/ }, { timeoutMs: 60_000 });
    await user.screenshot();
    await user.click({ role: "link", label: /prep-a-sales-call|Prep a sales call/ });
    await user.see({ testId: "skill-detail" }, { timeoutMs: 60_000 });
    await user.see({ text: "Read the account notes, then list three questions to ask." });
    expect((await probe.dom("[data-library-integrated-header]")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("skill detail preserves its saved steps", "The shared header and Skill steps are visible; the complete authored text is unchanged", true);
    await user.screenshot();
  });

  await step("after: the Plugins list has name-over-description rows, straight state and action lanes, and an inline filter", async () => {
    await user.navigate(`${base}/dashboard/plugins/${pluginId}`);
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Add team" });
    await user.click({ role: "option", label: /Sales/ });
    await user.click({ role: "button", label: "Add Sales" });
    await user.see({ testId: "access-team" }, { text: /Sales/, timeoutMs: 60_000 });
    await user.click({ role: "link", label: "Plugins" });
    await user.see({ text: "Sales call prep" });
    await user.see({ placeholder: "Filter by name" });
    await user.see({ text: "Shared" }, { timeoutMs: 30_000 });
    const row = (await probe.dom('[data-plugin-row="Sales call prep"] [data-library-integrated-row]')).elements;
    expect(row).toHaveLength(1);
    expect(row[0]?.text).toContain("Get ready for a sales call");
    expect(row[0]?.text).toContain("Shared");
    expect((await probe.dom('[data-testid="plugin-directory-columns"]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("the same bounded directory uses shared list rows", "Sales call prep has its description and Shared state; Filter by name is inline; no non-numeric column header", true);
    await user.screenshot();
    await user.resizeViewport({ width: 320, height: 800, deviceScaleFactor: 1 });
    const narrow = await probe.dom('[data-plugin-row="Sales call prep"]');
    expect(narrow.documentWidth).toBeLessThanOrEqual(narrow.viewportWidth);
    await user.see({ role: "button", label: "More for Sales call prep" });
    await user.screenshot();
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  });

  await step("after: My Library puts the add picker next to the collection and reports Ready as a word", async () => {
    await user.navigate(`${base}/dashboard/library`);
    await user.see({ text: "Sales call prep" });
    await user.see({ role: "button", label: "Add to library" });
    const status = (await probe.dom('[data-library-item="Sales call prep"] [data-item-status]')).elements;
    expect(status[0]?.text).toBe("Ready");
    await user.screenshot();
    await user.click({ role: "button", label: "Add to library" });
    await user.see({ testId: "library-add-dialog" });
    await user.see({ role: "radio", label: /^Connector/ });
    await user.see({ role: "button", label: "Continue" });
    evidence.recordAssertionEvidence("the add flow keeps its choices and continuation", "Ready is visible in the row; Add to library opens Connector, Skill and Plugin choices with the same Continue action", true);
    await user.screenshot();
    await user.click({ role: "button", label: "Continue" });
  });

  await step("after: the connector catalog uses an inline filter and keeps custom addresses behind Add another MCP", async () => {
    await user.see({ testId: "connector-catalog" }, { timeoutMs: 60_000 });
    await user.see({ role: "link", label: "Add Slack" });
    const filter = (await probe.dom('input[aria-label="Filter by name"]')).elements[0];
    expect(filter?.rect.width).toBeLessThanOrEqual(240);
    await user.notSee({ role: "textbox", label: "Address" });
    await user.screenshot();
    await user.click({ role: "button", label: "Add another MCP" });
    await user.see({ testId: "connector-picker-custom" });
    await user.see({ role: "textbox", label: "Address" });
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
    const connections = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(isRecord(connections.body) ? records(connections.body.connections) : []).toHaveLength(0);
    evidence.recordAssertionEvidence("catalog browsing never changes connections", "Slack remains a marked catalog row; the filter is at most 240px; Address appears only after Add another MCP; cancel leaves zero connections", true);
  });

  await step("a Sales member can use the plugin but cannot manage or remove it",  async () => {
    await member.reload();
    await member.see({ text: "Sales call prep" }, { timeoutMs: 60_000 });
    await member.screenshot();
    await member.click({ role: "link", label: /Sales call prep/ });
    await member.see({ testId: "plugin-manage-locked" });
    await member.see({ role: "button", label: "Manage" });
    expect((await memberProbe.dom('[data-testid="plugin-page"] button[disabled]')).elements.some((item) => item.text === "Manage")).toBe(true);
    await member.notSee({ role: "button", label: "More for Sales call prep" });
    await member.notSee({ role: "button", label: "Add team" });
    const memberLibrary = await probe.api(world.den.members.omar, "/v1/me/library");
    const granted = isRecord(memberLibrary.body) ? records(memberLibrary.body.items).find((item) => item.id === pluginId) : undefined;
    expect(granted?.role).toBe("viewer");
    const manageable = await probe.api(world.den.members.omar, `/v1/plugins/${pluginId}/access`);
    const context = await probe.api(world.den.members.omar, "/v1/org");
    expect(isRecord(context.body) && isRecord(context.body.currentMember) && context.body.currentMember.role).toBe("member");
    expect((await memberProbe.dom('[data-testid="whats-inside"]')).elements[0]?.text).toContain("Prep a sales call");
    evidence.recordAssertionEvidence("the rollout grants no new manage permission", `Sales member sees the skill and a manager/admin lock; no manage menu or Add team; access read HTTP ${manageable.response.status}`, true);
    await member.screenshot();
  });

  await step("before again: turning the rollout off restores the old list and detail without losing the plugin or its Sales grant", async () => {
    await user.navigate(`${base}/admin`);
    await user.see({ role: "button", label: /^Organizations/ }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: /^Organizations/ });
    await user.type({ placeholder: "Org name, slug, or id" }, world.organizationSlug);
    await user.click({ testId: "admin-capability-libraryIntegrated" });
    await probe.eventually(async () => {
      const context = await probe.api(world.den.admin, "/v1/org");
      return isRecord(context.body) && isRecord(context.body.features) && context.body.features.libraryIntegrated;
    }, { within: 30_000, label: "the Library rollout is off", until: (enabled) => enabled === false });
    await user.navigate(`${base}/dashboard/plugins`);
    await user.see({ testId: "plugin-directory-columns" }, { timeoutMs: 60_000 });
    await user.see({ text: "Sales call prep" });
    expect((await probe.dom("[data-library-integrated-row]")).elements).toHaveLength(0);
    await user.screenshot();
    await user.click({ role: "link", label: /Sales call prep/ });
    await user.see({ testId: "access-team" }, { text: /Sales/ });
    expect((await probe.dom("[data-library-integrated-header]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("the kill-safe fallback retains the same object and grants", "libraryIntegrated=false; original directory columns and detail header restored; Sales still has access", true);
    await user.screenshot();
  });
});
