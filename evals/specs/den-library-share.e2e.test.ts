import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denLibraryManage, denLibraryWithSamsSlack } from "../worlds/den-library-manage.ts";

// Members add things to My Library for themselves and share them with the
// people and teams who need them.
const test = spec.world(denLibraryManage, { timeout: 600_000 });
const withSlack = spec.world(denLibraryWithSamsSlack, { timeout: 600_000 });

const names = (items: { name: string }[]) => items.map((item) => item.name);

test("a member: I want Maya and the Support team to use Slack so they can search messages without asking me", async ({ world, user, probe, step }) => {
  const library = `${world.den.ref.webUrl}/dashboard/library`;

  await step("1. I open My Library: it keeps its shape while it loads, then it is empty and the sidebar only shows my own work", async () => {
    await user.see({ testId: "library-empty" }, { timeoutMs: 120_000 });
    await world.proxy.faults.latency("/v1/me/library", 5_000);
    await user.reload();
    await user.see({ testId: "item-rows-skeleton", label: "Loading your Library" }, { timeoutMs: 60_000 });
    await user.screenshot();
    await user.see({ testId: "library-empty" }, { timeoutMs: 60_000 });
    await user.see({ text: "Nothing in your Library yet" });
    const links = await probe.eventually(() => world.sidebarLinks(), {
      within: 30_000, label: "member sidebar", until: (labels) => labels.includes("My Library"),
    });
    expect(links).toContain("My Library");
    for (const label of ["Plugins", "Connectors", "Models", "Desktop policies", "Members", "Settings"]) expect(links).not.toContain(label);
    await user.notSee({ text: "Manage" });
    await user.screenshot();
  });

  await step("2. I cannot open Manage pages by typing their address", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections`);
    await probe.eventually(() => world.location(), {
      within: 30_000, label: "redirect away from Manage", until: (path) => !path.startsWith("/dashboard/mcp-connections"),
    });
    await user.navigate(library);
    await user.see({ testId: "library-empty" }, { timeoutMs: 60_000 });
    await user.screenshot();
  });

  await step("3. I choose Add to your Library and pick Connector", async () => {
    await user.click({ role: "button", label: "Add to your Library" });
    await user.see({ testId: "library-add-dialog" }, { text: /Connect the tools your AI works in/ });
    await user.click({ testId: "library-add-connector" });
    await user.screenshot();
  });

  await step("4. I find Slack in the list and add it", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Add another MCP" });
    await user.type({ label: "Filter by name" }, "acme", { replace: true });
    await user.see({ testId: "connector-picker-no-match" }, { text: /No app called “acme”/ });
    await user.screenshot();
    await user.click({ testId: "connector-picker-no-match-add" });
    await user.see({ testId: "connector-picker-custom" }, { text: /Paste the address your vendor or IT team gave you/ });
    await user.notSee({ testId: "connector-picker-no-match" });
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
    await user.type({ label: "Filter by name" }, "", { replace: true });
    await user.click({ role: "link", label: "Add Slack" });
    await user.see({ role: "heading", label: "Connect Slack" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Sign in with Slack" }, { timeoutMs: 60_000 });
    await user.see({ testId: "step-footer-note" }, { text: "Step 3 of 4" });
    expect(await world.servedPinnedCatalog(), "the catalog and checks came from the mock, not a real provider").toBe(true);
    await user.screenshot();
  });

  await step("5. I sign in with my own Slack account", async () => {
    await user.click({ role: "button", label: "Sign in with Slack" });
    await user.see({ role: "heading", label: "Slack is ready" }, { timeoutMs: 120_000 });
    await user.see({ text: "Only you can use it. Share it when your team needs it too." });
    await user.see({ testId: "step-footer-note" }, { text: "All 4 steps done" });
    const tab = await world.signInTab({ timeoutMs: 1_000 });
    if (tab?.client.targetId) await world.web.client.send("Target.closeTarget", { targetId: tab.client.targetId });
    await user.screenshot();
  });

  await step("6. I share Slack with Maya and the Support team", async () => {
    await user.click({ role: "link", label: "Share" });
    await user.see({ role: "heading", label: "Share Slack" }, { timeoutMs: 60_000 });
    await user.see({ testId: "access-owner" }, { text: /Sam K\. \(you\)/ });
    await user.click({ role: "button", label: "Add person" });
    await user.type({ placeholder: "Search people" }, "Maya");
    await user.click({ role: "option", label: /Maya Chen/ });
    await user.click({ role: "button", label: "Add Maya Chen" });
    await user.click({ role: "button", label: "Add team" });
    await user.click({ role: "option", label: /Support/ });
    await user.click({ role: "button", label: "Add Support" });
    await user.see({ testId: "access-person" }, { text: /Maya Chen/ });
    await user.see({ testId: "access-team" }, { text: /Support/ });
    await user.see({ testId: "step-footer-note" }, { text: "Maya and Support will find it in My Library." });
    await user.screenshot();
  });

  await step("after: Maya and everyone in Support find Slack in My Library, and Kai, who is outside Support, does not", async () => {
    const reach = 1 + world.teamSize("Support");
    await user.click({ role: "button", label: `Share with ${reach} people` });
    await user.see({ testId: "den-toast" }, { text: /Slack is shared/, timeoutMs: 60_000 });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`${reach} people can use it now\\.`) });
    await user.see({ testId: "library-section-mine" }, { text: /Slack/, timeoutMs: 60_000 });
    await user.see({ text: "Shared with Maya and Support" });
    for (const person of ["maya", "ana", "lee", "noor"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} has Slack`).toContain("Slack");
    }
    expect(names(await world.library(world.den.members.kai)), "Kai is outside Support").not.toContain("Slack");
    await user.screenshot();
  });
});

withSlack("a member: I want Sales to use my plugin so every sales call starts with the same prep", async ({ world, user, probe, step }) => {
  await step("1. I choose Add to your Library and pick Plugin", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/library`);
    await user.see({ testId: "library-section-mine" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Add to your Library" });
    await user.click({ testId: "library-add-plugin" });
    await user.click({ role: "button", label: "Continue" });
    await user.see({ testId: "plugin-create-form" }, { timeoutMs: 60_000 });
    await user.see({ text: "Only you can use it until you share it." });
    await user.screenshot();
  });

  await step("2. I name it and put a skill, a command and my Slack inside", async () => {
    await user.type({ placeholder: "Sales call prep" }, "Sales call prep");
    await user.type({ placeholder: "What it helps people do" }, "Get ready for a sales call");
    await user.click({ role: "button", label: /^Skill$/ });
    await user.type({ role: "textbox", label: "Skill name" }, "Prep a sales call");
    await user.type({ role: "textbox", label: "When to use it" }, "Before any call with a customer");
    await user.type({ role: "textbox", label: "Skill steps" }, "Read the account notes, then list three questions to ask.");
    await user.click({ role: "button", label: /^Command$/ });
    await user.type({ role: "textbox", label: "Command name" }, "/follow-up");
    await user.type({ role: "textbox", label: "What it does" }, "Draft the follow-up message");
    await user.type({ role: "textbox", label: "Command steps" }, "Write a short thank-you with the next steps we agreed on.");
    await user.click({ role: "button", label: /^Connector$/ });
    await user.click({ role: "radio", label: /Slack/ });
    await user.screenshot();
  });

  await step("3. I create it and see what's inside", async () => {
    await user.click({ role: "button", label: "Create plugin" });
    await user.see({ testId: "plugin-page" }, { timeoutMs: 60_000 });
    await user.see({ role: "heading", label: "Sales call prep" });
    await user.see({ testId: "whats-inside" }, { text: /3 things/ });
    await user.see({ testId: "whats-inside" }, { text: /Prep a sales call/ });
    await user.see({ testId: "whats-inside" }, { text: /\/follow-up/ });
    await user.see({ text: "Only you" });
    await user.screenshot();
  });

  await step("4. I share it with the Sales team", async () => {
    await user.click({ role: "link", label: "Share" });
    await user.see({ role: "heading", label: "Share Sales call prep" }, { timeoutMs: 60_000 });
    await user.see({ text: /They get the skill, the command and Slack\. Each person uses their own Slack account\./ });
    await user.click({ role: "button", label: "Add team" });
    await user.click({ role: "option", label: /Sales/ });
    await user.click({ role: "button", label: "Add Sales" });
    await user.see({ testId: "step-footer-note" }, { text: "Sales will find it in My Library." });
    await user.screenshot();
  });

  await step("after: everyone in Sales finds Sales call prep in My Library, and Kai, who is outside Sales, does not", async () => {
    const reach = world.teamSize("Sales");
    await user.click({ role: "button", label: `Share with ${reach} people` });
    await user.see({ testId: "den-toast" }, { text: /Sales call prep is shared/, timeoutMs: 60_000 });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`${reach} people in Sales can use it now\\.`) });
    await user.see({ text: "Shared with Sales" }, { timeoutMs: 60_000 });
    for (const person of ["omar", "tess"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} has the plugin`).toContain("Sales call prep");
      const usable = await probe.api(world.den.members[person], "/v1/mcp-connections?scope=usable");
      expect(usable.text, `${person} can sign in to the Slack inside it`).toContain('"name":"Slack"');
    }
    expect(names(await world.library(world.den.members.kai)), "Kai is outside Sales").not.toContain("Sales call prep");
    await user.screenshot();
  });
});
