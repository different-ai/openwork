import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automationSharingWorld } from "../worlds/automation-sharing.ts";

const test = spec.world(automationSharingWorld, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

const WITHIN = 45_000;

test("a member shares their Automation with one teammate, who adds a paused copy of their own", async ({ world, user, probe, step, evidence }) => {
  const sam = user.on(world.owner);
  const riley = user.on(world.teammate);
  const samPage = probe.on(world.owner);
  const rileyPage = probe.on(world.teammate);
  const count = async (page: typeof samPage, selector: string) => (await page.dom(selector)).elements.length;
  const texts = async (page: typeof samPage, selector: string) => (await page.dom(selector)).elements.map((element) => element.text);

  await step("before: with sharing off the owner has no Share action and Den refuses the shared list", async () => {
    await sam.click({ role: "button", label: "Automations" });
    await sam.click({ role: "button", label: new RegExp(world.name) });
    await sam.see({ role: "button", label: "Archive Automation" }, { timeoutMs: WITHIN });
    const shareButtons = await count(samPage, "[data-automation-share]");
    const refused = await world.sharedWithTeammate();
    expect(shareButtons).toBe(0);
    expect(refused.status).toBe(404);
    expect(refused.error).toBe("feature_disabled");
    evidence.recordAssertionEvidence("With sharing off there is no Share action and Den refuses the shared list",
      `The owner's "${world.name}" shows ${shareButtons} Share buttons; the teammate's shared list answers ${refused.status} ${refused.error}`,
      shareButtons === 0 && refused.status === 404);
    await sam.screenshot();
  });

  await step("the owner opens Share and picks one teammate; sharing with everyone is locked for a plain member", async () => {
    await world.setSharing(true);
    await sam.reload();
    await sam.click({ role: "button", label: "Automations" }, { timeoutMs: WITHIN });
    await sam.click({ role: "button", label: new RegExp(world.name) }, { timeoutMs: WITHIN });
    await sam.click({ role: "button", label: "Share" }, { timeoutMs: WITHIN });
    await sam.see({ text: `Share ${world.name}` }, { timeoutMs: WITHIN });
    await sam.click({ role: "button", label: "Add people" }, { timeoutMs: WITHIN });
    await sam.click({ role: "menuitem", label: new RegExp(world.teammateName) });
    await sam.see({ role: "button", label: `Remove ${world.teammateName}` }, { timeoutMs: WITHIN });
    const everyoneLocked = await count(samPage, "#automation-sharing-everyone:disabled");
    const lockReason = (await texts(samPage, "#automation-sharing-permission"))[0] ?? "";
    expect(everyoneLocked).toBe(1);
    expect(lockReason).toContain("An organization owner or admin can give you permission to share with everyone.");
    evidence.recordAssertionEvidence("The owner picks a teammate; the everyone switch is visible but locked with the reason",
      `${world.teammateName} is in the audience; "Everyone in the organization" is disabled and reads "${lockReason}"`,
      everyoneLocked === 1 && lockReason.length > 0);
    await sam.screenshot();
  });

  await step("after: saving shares it with that teammate only", async () => {
    await sam.click({ role: "button", label: "Save changes" });
    await sam.see({ text: "Shared with 1 person" }, { timeoutMs: WITHIN });
    const label = await samPage.eventually(() => texts(samPage, "[data-automation-share]"), { within: WITHIN, label: "the button reads Shared", until: (found) => found[0] === "Shared" });
    const teammateList = await world.sharedWithTeammate();
    const outsiderList = await world.sharedWithOutsider();
    const outsiderCopy = await world.outsiderCopy();
    expect(teammateList.items).toEqual([{ id: world.automationId, name: world.name, sharedBy: world.ownerName }]);
    expect(outsiderList.items).toEqual([]);
    expect(outsiderCopy.status).toBe(404);
    evidence.recordAssertionEvidence("Only the chosen teammate can see or copy it",
      `The button reads "${label[0]}"; the teammate's shared list is "${teammateList.items.map((item) => item.name).join(", ")}" shared by ${teammateList.items[0]?.sharedBy}; the outsider's list has ${outsiderList.items.length} entries and their copy attempt answers ${outsiderCopy.status} ${outsiderCopy.error}`,
      teammateList.items.length === 1 && outsiderList.items.length === 0 && outsiderCopy.status === 404);
    await sam.screenshot();
  });

  await step("the teammate finds it under Shared with you, with who shared it", async () => {
    await riley.reload();
    await riley.click({ role: "button", label: "Automations" }, { timeoutMs: WITHIN });
    await riley.see({ text: "Shared with you" }, { timeoutMs: WITHIN });
    const rows = await texts(rileyPage, "[data-shared-automation-id]");
    const mine = await world.teammateAutomations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(world.name);
    expect(rows[0]).toContain(`Shared by ${world.ownerName}`);
    expect(mine).toEqual([]);
    evidence.recordAssertionEvidence("The teammate sees one shared Automation and still owns none",
      `Shared with you lists "${world.name}", "Shared by ${world.ownerName}"; the teammate's own Automations: ${mine.length}`,
      rows.length === 1 && mine.length === 0);
    await riley.screenshot();
  });

  let copyId = "";
  await step("after: Add to my Automations gives the teammate their own paused copy", async () => {
    await riley.click({ role: "button", label: "Add to my Automations" });
    await riley.see({ text: "Added to your Automations. It's paused until you turn it on." }, { timeoutMs: WITHIN });
    await riley.see({ role: "button", label: "Archive Automation" }, { timeoutMs: WITHIN });
    const mine = await world.teammateAutomations();
    const theirs = await world.ownerAutomations();
    const shareOnCopy = await texts(rileyPage, "[data-automation-share]");
    copyId = mine[0]?.id ?? "";
    expect(mine).toEqual([{ id: copyId, name: world.name, state: "inactive", scheduled: false }]);
    expect(copyId).not.toBe(world.automationId);
    expect(theirs.map((item) => item.id)).toEqual([world.automationId]);
    expect(shareOnCopy).toEqual(["Share"]);
    evidence.recordAssertionEvidence("The copy belongs to the teammate, is paused with no next run, and the owner's Automation is untouched",
      `The teammate now owns "${mine[0]?.name}" (${mine[0]?.state}, next run ${mine[0]?.scheduled ? "scheduled" : "not scheduled"}), a different Automation from the owner's; the owner still has ${theirs.length}; the copy opens with its own "${shareOnCopy[0]}" button`,
      mine.length === 1 && mine[0]?.state === "inactive" && !mine[0]?.scheduled && copyId !== world.automationId);
    await riley.screenshot();
  });

  await step("after: the owner stops sharing; it leaves the teammate's list and their copy stays", async () => {
    await sam.click({ role: "button", label: "Shared" });
    await sam.click({ role: "button", label: `Remove ${world.teammateName}` }, { timeoutMs: WITHIN });
    await sam.click({ role: "button", label: "Save changes" });
    await sam.see({ text: "No longer shared" }, { timeoutMs: WITHIN });
    await riley.click({ role: "button", label: "Back to Automations" });
    await riley.see({ role: "button", label: new RegExp(world.name) }, { timeoutMs: WITHIN });
    await riley.notSee({ text: "Shared with you" }, { timeoutMs: WITHIN });
    const teammateList = await world.sharedWithTeammate();
    const mine = await world.teammateAutomations();
    const cards = await count(rileyPage, `[data-automation-id="${copyId}"]`);
    expect(teammateList.items).toEqual([]);
    expect(mine.map((item) => item.id)).toEqual([copyId]);
    expect(cards).toBe(1);
    evidence.recordAssertionEvidence("Unsharing removes it from Shared with you and keeps the copy",
      `The teammate's shared list has ${teammateList.items.length} entries and the page no longer shows "Shared with you"; their copy is still in their own Automations`,
      teammateList.items.length === 0 && cards === 1);
    await riley.screenshot();
  });
});
