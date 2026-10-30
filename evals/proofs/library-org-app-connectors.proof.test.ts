import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryOrgAppConnectors } from "../worlds/library-org-app-connectors.ts";

const test = spec.world(libraryOrgAppConnectors, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const WITHIN = 90_000;
const SETUP = '[data-testid="library-connector-setup"]';

// DESIGN P4/C5: a connector the member cannot set up stays visible, locked in
// neutral ink, and names who can change it. P10: each state is a screenshot.
test("a member sees Slack locked until an admin sets it up, and signs in to a connector the organization already has in one click", async ({ world, user, probe, step, evidence }) => {
  const member = user.on(world.member.app);
  const memberProbe = probe.on(world.member.app);
  const row = async (name: string) => (await memberProbe.dom(`[data-connector="${name}"]`)).elements.map((element) => element.text).join(" ");
  async function openCatalog() {
    await member.navigate(world.member.libraryUrl);
    await member.see({ role: "button", label: "Add to library" }, { timeoutMs: WITHIN });
    await member.click({ role: "button", label: "Add to library" });
    // Connector is the first kind and already selected.
    await member.click({ role: "button", label: "Continue" });
    await member.see({ testId: "library-connector-catalog" }, { timeoutMs: WITHIN });
    await member.see({ role: "button", label: "Add Slack" }, { timeoutMs: WITHIN });
  }

  await step("the member's catalog offers Sign in for Team notes, which the organization already has", async () => {
    await openCatalog();
    await member.see({ role: "button", label: "Sign in with Team notes" }, { timeoutMs: WITHIN });
    const notes = await row("Team notes");
    const render = await row("Render");
    const ok = notes.includes("Sign in with Team notes") && !notes.includes("Added") && render.includes("Add");
    evidence.recordAssertionEvidence("An added connector the member has not signed in to offers Sign in, not an inert Added", `Team notes: "${notes}"; Render: "${render}"`, ok);
    expect(ok).toBe(true);
    await member.screenshot();
  });

  await step("after: Slack says Not set up for your organization, names the admin, and asks for no app codes", async () => {
    await member.click({ role: "button", label: "Add Slack" });
    await member.see({ text: "Not set up for your organization" }, { timeoutMs: WITHIN });
    await member.see({ text: "An admin adds your organization's Slack app in OpenWork Cloud. Then you sign in with your own Slack account." });
    const inputs = (await memberProbe.dom(`${SETUP} input`)).elements.length;
    const locked = (await memberProbe.dom('[data-testid="library-connector-locked"]')).elements.map((element) => element.text).join(" ");
    const page = (await memberProbe.dom(SETUP)).elements.map((element) => element.text).join(" ");
    const ok = inputs === 0 && locked.includes("Sign in with Slack") && !page.includes("Client ID") && !page.includes("{name}") && !page.includes("Set up in OpenWork Cloud");
    evidence.recordAssertionEvidence("The member sees a locked Slack with its owner, and nothing to type", `fields=${inputs}; locked action="${locked}"; asks for client ID=${page.includes("Client ID")}; raw placeholder shown=${page.includes("{name}")}`, ok);
    expect(ok).toBe(true);
    await member.screenshot();
  });

  await step("Render, which signs in with OpenWork's own app, is a plain sign-in", async () => {
    await member.click({ role: "button", label: "Cancel" });
    await openCatalog();
    await member.click({ role: "button", label: "Add Render" });
    await member.see({ role: "button", label: "Sign in with Render" }, { timeoutMs: WITHIN });
    await member.notSee({ text: "Not set up for your organization" });
    const inputs = (await memberProbe.dom(`${SETUP} input`)).elements.length;
    evidence.recordAssertionEvidence("A preset with OpenWork's own app needs no organization setup", `fields=${inputs}; primary action=Sign in with Render`, inputs === 0);
    expect(inputs).toBe(0);
    await member.screenshot();
  });

  await step("after: Sign in with Team notes starts the member's own sign-in in a new tab", async () => {
    await member.click({ role: "button", label: "Cancel" });
    await openCatalog();
    const before = await world.openedTabs(world.member.app);
    await member.click({ role: "button", label: "Sign in with Team notes" });
    const opened = await probe.eventually(() => world.openedTabs(world.member.app), {
      within: 45_000, label: "the member's sign-in opens", until: (tabs) => tabs.length > before.length,
    });
    const tab = opened.find((url) => !before.includes(url)) ?? "";
    const origin = tab ? new URL(tab).origin : "";
    evidence.recordAssertionEvidence("One click opens the per-person sign-in for the organization's connection", `new tab origin=${origin}; local notes server=${world.notesOrigin}`, Boolean(tab));
    expect(tab).not.toBe("");
    await member.screenshot();
  });
});

test("an owner is sent to OpenWork Cloud to add the organization's Slack app", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner.app);
  const ownerProbe = probe.on(world.owner.app);

  await step("the owner opens Slack from Add a connector and sees Set up in OpenWork Cloud", async () => {
    await owner.navigate(world.owner.libraryUrl);
    await owner.see({ role: "button", label: "Add to library" }, { timeoutMs: WITHIN });
    await owner.click({ role: "button", label: "Add to library" });
    await owner.click({ role: "button", label: "Continue" });
    await owner.see({ role: "button", label: "Add Slack" }, { timeoutMs: WITHIN });
    await owner.click({ role: "button", label: "Add Slack" });
    await owner.see({ role: "button", label: "Set up in OpenWork Cloud" }, { timeoutMs: WITHIN });
    await owner.see({ text: "Add your organization's Slack app once in OpenWork Cloud. Then everyone signs in with their own Slack account." });
    const inputs = (await ownerProbe.dom(`${SETUP} input`)).elements.length;
    const page = (await ownerProbe.dom(SETUP)).elements.map((element) => element.text).join(" ");
    const ok = inputs === 0 && !page.includes("Client ID") && !page.includes("Sign in with Slack");
    evidence.recordAssertionEvidence("The owner gets one way forward and nothing to paste in the app", `fields=${inputs}; asks for client ID=${page.includes("Client ID")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("after: Set up in OpenWork Cloud opens Den's Slack setup", async () => {
    const before = await world.openedTabs(world.owner.app);
    await owner.click({ role: "button", label: "Set up in OpenWork Cloud" });
    const opened = await probe.eventually(() => world.openedTabs(world.owner.app), {
      within: 30_000, label: "OpenWork Cloud opens", until: (tabs) => tabs.some((url) => !before.includes(url)),
    });
    const tab = opened.find((url) => !before.includes(url)) ?? "";
    const path = tab ? new URL(tab).pathname : "";
    evidence.recordAssertionEvidence("The button opens the admin connector setup for Slack", `opened=${path}`, path === "/dashboard/mcp-connections/new/slack");
    expect(path).toBe("/dashboard/mcp-connections/new/slack");
    await owner.screenshot();
  });
});
