import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denManageAsAdmin } from "../worlds/den-library-manage.ts";
import { isRecord, records } from "../worlds/library.ts";

// Admins add a connector once in Manage and choose which teams get it.
const test = spec.world(denManageAsAdmin, { timeout: 600_000 });

const names = (items: { name: string }[]) => items.map((item) => item.name);

test("an admin: I want Sales and Support to have Slack so nobody sets it up alone", async ({ world, user, probe, step, evidence }) => {
  const reach = world.teamSize("Sales") + world.teamSize("Support");

  await step("1. I open Connectors in Manage: nothing is set up yet", async () => {
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 120_000 });
    await user.see({ text: "Apps your organization's AI can use. You choose who gets each one." });
    await user.see({ text: "Members can still add apps for themselves in My Library." });
    const links = await probe.eventually(() => world.sidebarLinks(), {
      within: 30_000, label: "admin sidebar", until: (labels) => labels.includes("Connectors"),
    });
    for (const label of ["My Library", "Plugins", "Connectors", "Members"]) expect(links).toContain(label);
    await user.screenshot();
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

  await step("3. I sign in with Slack once to try it, and all four checks stay on screen until I continue", async () => {
    await user.click({ role: "button", label: "Sign in with Slack" });
    await user.see({ role: "heading", label: "Slack passed all 4 checks" }, { timeoutMs: 120_000 });
    const tab = await world.signInTab({ timeoutMs: 1_000 });
    if (tab?.client.targetId) await world.web.client.send("Target.closeTarget", { targetId: tab.client.targetId });
    const done = await probe.dom('[data-testid^="setup-check-"][data-status="done"]');
    await user.see({ testId: "step-footer-note" }, { text: "Next, choose who can use it." });
    await user.see({ role: "button", label: "Continue" });
    await user.notSee({ role: "radio", label: /Each person signs in/ });
    const accessChoices = await probe.dom('input[name="sign-in-mode"]');
    const ticked: string[] = [];
    for (const row of ["find", "sign-in-method", "sign-in", "tools"]) {
      if ((await probe.dom(`[data-testid="setup-check-${row}"][data-status="done"]`)).elements.length === 1) ticked.push(row);
    }
    evidence.recordAssertionEvidence(
      "after signing in, the admin sees all four checks ticked and continues when ready",
      `${ticked.length} of 4 ticked (${ticked.join(", ")}); ${accessChoices.elements.length} sign-in choices on screen before Continue`,
      ticked.length === 4 && accessChoices.elements.length === 0,
    );
    expect(done.elements, "every check is ticked").toHaveLength(4);
    await user.screenshot();
  });

  await step("4. I continue, let each person sign in and give it to Sales and Support", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "radio", label: /Each person signs in/ }, { timeoutMs: 30_000 });
    const chosen = await probe.dom('input[name="sign-in-mode"][value="per_member"]:checked');
    expect(chosen.elements, "each person signs in is the default").toHaveLength(1);
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
    const seen: { person: string; hasSlack: boolean; credentialMode: unknown }[] = [];
    for (const person of ["omar", "tess", "ana", "lee", "noor"] as const) {
      const hasSlack = names(await world.library(world.den.members[person])).includes("Slack");
      const usable = await probe.api(world.den.members[person], "/v1/mcp-connections?scope=usable");
      const slack = isRecord(usable.body) ? records(usable.body.connections).find((entry) => entry.name === "Slack") : undefined;
      seen.push({ person, hasSlack, credentialMode: slack?.credentialMode });
    }
    const kaiHasSlack = names(await world.library(world.den.members.kai)).includes("Slack");
    evidence.recordAssertionEvidence(
      "everyone in Sales and Support has Slack and signs in as themselves; Kai does not have it",
      [...seen.map((entry) => `${entry.person}: ${entry.hasSlack ? `Slack, ${String(entry.credentialMode)}` : "no Slack"}`), `kai: ${kaiHasSlack ? "Slack" : "no Slack"}`].join("; "),
      seen.every((entry) => entry.hasSlack && entry.credentialMode === "per_member") && !kaiHasSlack,
    );
    for (const entry of seen) {
      expect(entry.hasSlack, `${entry.person} has Slack`).toBe(true);
      expect(entry.credentialMode, `${entry.person} signs in with their own account`).toBe("per_member");
    }
    expect(kaiHasSlack, "Kai is in neither team").toBe(false);
    await user.screenshot();
  });
});
