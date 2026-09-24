import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord, records } from "../worlds/library.ts";
import { denManagePluginsAsAdmin } from "../worlds/den-library-manage.ts";

// Admins build a plugin once in Manage and choose which teams get it.
const test = spec.world(denManagePluginsAsAdmin, { timeout: 600_000 });

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

  await step("after: Omar and Tess in Sales find Sales call prep in My Library, and Kai, who is outside Sales, does not", async () => {
    for (const person of ["omar", "tess"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} has the plugin`).toContain("Sales call prep");
    }
    expect(names(await world.library(world.den.members.kai)), "Kai is outside Sales").not.toContain("Sales call prep");
    await user.screenshot();
  });
});
