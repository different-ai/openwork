import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automationTeamSharingWorld } from "../worlds/automation-team-sharing.ts";

/**
 * Sharing an Automation with a team (automationTeamSharing): the owner
 * decides which of their teams see it and whether they can operate it; it
 * keeps running with the owner's accounts until a manager takes it over.
 */

const test = spec.world(automationTeamSharingWorld, {
  resources: { surfaces: ["web", "appWeb"], services: ["den"] },
  timeout: 600_000,
});

test("an owner shares an Automation with their team, a teammate manages and takes it over, and a member outside the team never sees it", async ({ world, user, probe, step, evidence }) => {
  const olive = user.on(world.oliveApp);
  const tess = user.on(world.tessApp);
  const tessDen = user.on(world.tessWeb);
  const una = user.on(world.unaWeb);

  const openAutomations = async (person: typeof olive) => {
    await person.click({ role: "button", label: "Automations" });
  };

  await step("before: the teammate has no Automations, her own or shared", async () => {
    await openAutomations(tess);
    await tess.see({ text: "No Automations yet" }, { timeoutMs: 90_000 });
    await tess.notSee({ text: world.name });
    const status = await world.asTess("read");
    evidence.recordAssertionEvidence("An Automation is its owner's alone until they share it", `Tess reading Olive's Automation: HTTP ${status}`, status === 404);
    expect(status).toBe(404);
    await tess.screenshot();
  });

  await step("the owner shares it with Sales as view only", async () => {
    await openAutomations(olive);
    await olive.click({ text: world.name });
    await olive.see({ role: "heading", label: world.name }, { timeoutMs: 90_000 });
    await olive.click({ role: "button", label: "Share" });
    await olive.see({ text: /It keeps running with your accounts/ }, { timeoutMs: 30_000 });
    await olive.click({ role: "combobox", label: "Sales access" });
    await olive.click({ role: "option", label: "Can view" });
    await olive.see({ role: "button", label: "Shared with Sales" }, { timeoutMs: 30_000 });
    const status = await world.asTess("read");
    evidence.recordAssertionEvidence("Sharing takes one choice per team", `Olive chose "Can view" for Sales; Tess reading it: HTTP ${status}`, status === 200);
    expect(status).toBe(200);
    await olive.screenshot();
  });

  await step("after: the teammate sees it under Shared with my teams and can only look", async () => {
    await tess.reload();
    await openAutomations(tess);
    await tess.see({ text: "Shared with my teams" }, { timeoutMs: 90_000 });
    await tess.see({ text: "Olive Owner · Sales" });
    await tess.screenshot();
    await tess.click({ text: world.name });
    await tess.see({ text: /View only\. Olive Owner can give Sales manage access\./ }, { timeoutMs: 60_000 });
    const lockedButtons = await probe.on(world.tessApp).dom("button:disabled");
    const locked = ["Edit", "Deactivate", "Run now"].every((label) => lockedButtons.elements.some((button) => button.text.trim() === label));
    const refused = await world.asTess("pause");
    evidence.recordAssertionEvidence(
      "View access reads, and the controls say who can change that",
      `Edit, Deactivate and Run now are shown locked; Tess pausing it through Den: HTTP ${refused}`,
      locked && refused === 403,
    );
    expect(locked).toBe(true);
    expect(refused).toBe(403);
    await tess.screenshot();
  });

  await step("Den's My Automations shows the teammate the same shared Automation, read only", async () => {
    await tessDen.reload();
    await tessDen.see({ text: /^shared with my teams$/i }, { timeoutMs: 60_000 });
    await tessDen.see({ text: "Olive Owner · Sales" });
    await tessDen.click({ text: world.name });
    await tessDen.see({ text: /Olive Owner · Sales · View only/ }, { timeoutMs: 30_000 });
    const listed = await world.sharedWith("tess");
    evidence.recordAssertionEvidence("Den lists what teams shared, with whose it is", `Shared with Tess: ${listed.join(", ") || "nothing"}`, listed.join() === "view of Olive Owner's");
    expect(listed).toEqual(["view of Olive Owner's"]);
    await tessDen.screenshot();
  });

  await step("the owner gives Sales manage access and the teammate pauses it", async () => {
    await olive.click({ role: "combobox", label: "Sales access" });
    await olive.click({ role: "option", label: "Can manage" });
    await olive.see({ text: "Shared with Sales" }, { timeoutMs: 30_000 });
    await probe.eventually(() => world.asTess("read"), { within: 30_000, label: "Tess can still read it", until: (status) => status === 200 });
    await tess.reload();
    await openAutomations(tess);
    await tess.click({ text: world.name });
    await tess.see({ text: /Runs with Olive Owner's accounts\./ }, { timeoutMs: 90_000 });
    await tess.click({ role: "button", label: "Deactivate" });
    await tess.see({ role: "button", label: "Activate" }, { timeoutMs: 30_000 });
    const record = await world.record();
    evidence.recordAssertionEvidence(
      "Manage access operates the owner's Automation without changing whose it is",
      `Tess paused it: state=${record.state}; still Olive's: ${record.ownerMemberId !== world.tessMemberId}`,
      record.state === "inactive" && record.ownerMemberId !== world.tessMemberId,
    );
    expect(record.state).toBe("inactive");
    await tess.screenshot();
  });

  await step("the teammate takes it over: it is hers, paused, and she can now edit it", async () => {
    await tess.click({ role: "button", label: "Take over this Automation" });
    await tess.see({ role: "heading", label: "Take over this Automation?" }, { timeoutMs: 30_000 });
    await tess.screenshot();
    await tess.click({ role: "button", label: /^Take over$/ });
    await tess.see({ text: "Taken over. Resume it when you are ready." }, { timeoutMs: 30_000 });
    // The owner's controls: she shares it now, and the team it was shared with still has it.
    await tess.see({ role: "button", label: "Shared with Sales" }, { timeoutMs: 30_000 });
    await tess.notSee({ text: /Runs with Olive Owner's accounts/ });
    const record = await world.record();
    evidence.recordAssertionEvidence(
      "Taking over changes the owner and leaves it paused",
      `owner is Tess: ${record.ownerMemberId === world.tessMemberId}; state=${record.state}`,
      record.ownerMemberId === world.tessMemberId && record.state === "inactive",
    );
    expect(record.ownerMemberId).toBe(world.tessMemberId);
    expect(record.state).toBe("inactive");
    await tess.screenshot();
  });

  await step("the previous owner now sees it as shared with her team", async () => {
    await olive.reload();
    await openAutomations(olive);
    await olive.see({ text: "Shared with my teams" }, { timeoutMs: 90_000 });
    await olive.see({ text: "Tess Teammate · Sales" });
    const listed = await world.sharedWith("olive");
    evidence.recordAssertionEvidence("The team keeps the Automation after a take-over", `Shared with Olive: ${listed.join(", ") || "nothing"}`, listed.join() === "manage of Tess Teammate's");
    expect(listed).toEqual(["manage of Tess Teammate's"]);
    await olive.screenshot();
  });

  await step("a member outside the team sees and reaches nothing", async () => {
    await una.reload();
    await una.notSee({ text: world.name });
    await una.notSee({ text: "Shared with my teams" });
    const outside = await world.asUna();
    const ok = outside.detail === 404 && outside.sharedCount === 0 && outside.run === 404;
    evidence.recordAssertionEvidence("Sharing with one team shares with nobody else", `Una: read ${outside.detail}, shared list ${outside.sharedCount} items, run ${outside.run}`, ok);
    expect(ok).toBe(true);
    await una.screenshot();
  });
});
