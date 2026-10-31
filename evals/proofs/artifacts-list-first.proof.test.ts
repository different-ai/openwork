import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { artifactsListFirstWorld } from "../worlds/artifacts-list-first.ts";

const test = spec.world(artifactsListFirstWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 600_000,
});

test("a member browses artifacts before opening one and keeps its unsaved review across navigation and pinning", async ({ world, user, probe, step, evidence }) => {
  const inside = { resourceUri: world.checklist.resourceUri };
  let openedFrames: Awaited<ReturnType<typeof world.frames>> = [];

  await step("your artifacts and team artifacts are listed without opening any of them or enabling a list rollout", async () => {
    await user.click({ role: "button", label: "Artifacts" });
    await user.see({ role: "button", label: "Open Project checklist" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Open Release notes" });
    await user.see({ role: "button", label: "Open Team overview" });
    await user.see({ role: "heading", label: "Yours" });
    await user.see({ role: "heading", label: "Team" });
    await user.see({ text: "Select an artifact to open it." });
    const yours = await probe.dom('section[aria-label="Yours"] button');
    const team = await probe.dom('section[aria-label="Team"] button');
    const frames = await world.frames();
    expect(yours.elements).toHaveLength(2);
    expect(team.elements).toHaveLength(1);
    expect(frames).toHaveLength(0);
    evidence.recordAssertionEvidence("Three available artifacts are grouped by ownership with no live App mounted", JSON.stringify({ yours: yours.elements.map(item => item.text), team: team.elements.map(item => item.text), frames: frames.length }), yours.elements.length === 2 && team.elements.length === 1 && frames.length === 0);
    await user.screenshot();
  });

  await step("opening the checklist opens only that artifact and the member marks it reviewed", async () => {
    await user.click({ role: "button", label: "Open Project checklist" });
    await user.see({ role: "heading", label: "Project checklist", mcpApp: inside }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Mark reviewed", mcpApp: inside });
    await user.see({ role: "heading", label: "Reviewed", mcpApp: inside });
    openedFrames = await world.frames();
    expect(openedFrames).toHaveLength(1);
    const otherFrames = await probe.dom(`[data-mcp-app-resource="${world.notes.resourceUri}"], [data-mcp-app-resource="${world.team.resourceUri}"]`);
    expect(otherFrames.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Only the selected checklist is live and its unsaved React state says Reviewed", JSON.stringify({ frames: openedFrames, otherApps: otherFrames.elements.length }), openedFrames.length === 1 && otherFrames.elements.length === 0);
    await user.screenshot();
  });

  await step("visiting Calendar leaves the checklist running but out of view", async () => {
    await user.click({ role: "button", label: "Calendar" });
    await user.see({ role: "button", label: "Today" }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", label: "Open Project checklist" });
    const frames = await world.frames();
    expect(frames).toEqual(openedFrames);
    evidence.recordAssertionEvidence("Calendar is visible while the same single checklist frame stays mounted", JSON.stringify({ before: openedFrames, inCalendar: frames }), JSON.stringify(frames) === JSON.stringify(openedFrames));
    await user.screenshot();
  });

  await step("returning from Calendar restores the reviewed checklist without reopening it", async () => {
    await user.click({ role: "button", label: "Artifacts" });
    await user.see({ role: "heading", label: "Reviewed", mcpApp: inside });
    const frames = await world.frames();
    expect(frames).toEqual(openedFrames);
    evidence.recordAssertionEvidence("The review and original iframe survive the Calendar round trip", JSON.stringify({ before: openedFrames, returned: frames, review: "Reviewed" }), JSON.stringify(frames) === JSON.stringify(openedFrames));
    await user.screenshot();
  });

  await step("pinning the open checklist moves it to Pinned without resetting the review", async () => {
    await user.click({ role: "button", label: "Pin" });
    await user.see({ role: "heading", label: "Pinned" });
    await user.see({ role: "button", label: "Unpin" });
    await user.see({ role: "heading", label: "Reviewed", mcpApp: inside });
    const pinned = await probe.dom('section[aria-label="Pinned"] button');
    const yours = await probe.dom('section[aria-label="Yours"] button');
    const frames = await world.frames();
    expect(pinned.elements).toHaveLength(1);
    expect(pinned.elements[0]?.text).toContain("Project checklist");
    expect(yours.elements).toHaveLength(1);
    expect(yours.elements[0]?.text).toContain("Release notes");
    expect(frames).toEqual(openedFrames);
    evidence.recordAssertionEvidence("Pin changes the list group, not the mounted App or its review", JSON.stringify({ pinned: pinned.elements.map(item => item.text), yours: yours.elements.map(item => item.text), frames }), pinned.elements.length === 1 && yours.elements.length === 1 && JSON.stringify(frames) === JSON.stringify(openedFrames));
    await user.screenshot();
  });

  await step("visiting a conversation and returning keeps the same pinned review", async () => {
    await user.click({ text: world.session.title });
    await user.see("composer", { editable: true });
    await user.notSee({ role: "button", label: "Open Project checklist" });
    const inChat = await world.frames();
    expect(inChat).toEqual(openedFrames);
    await user.click({ role: "button", label: "Artifacts" });
    await user.see({ role: "heading", label: "Reviewed", mcpApp: inside });
    await user.see({ role: "button", label: "Unpin" });
    const returned = await world.frames();
    expect(returned).toEqual(openedFrames);
    evidence.recordAssertionEvidence("Conversation navigation neither duplicates nor remounts the pinned checklist", JSON.stringify({ before: openedFrames, inChat, returned }), JSON.stringify(inChat) === JSON.stringify(openedFrames) && JSON.stringify(returned) === JSON.stringify(openedFrames));
    await user.screenshot();
  });

  await step("switching to the narrow Tools pane does not destroy the pinned review", async () => {
    await user.click({ text: world.session.title });
    await user.click({ role: "button", label: "Open side panel" });
    await user.resizeViewport({ width: 720, height: 900, deviceScaleFactor: 1 });
    await user.see({ role: "tab", label: "Tools" });
    await user.click({ role: "tab", label: "Tools" });
    const inTools = await world.frames();
    expect(inTools).toEqual(openedFrames);
    await user.resizeViewport({ width: 1280, height: 813, deviceScaleFactor: 1 });
    await user.click({ role: "button", label: "Artifacts" });
    await user.see({ role: "heading", label: "Reviewed", mcpApp: inside });
    const returned = await world.frames();
    expect(returned).toEqual(openedFrames);
    evidence.recordAssertionEvidence("A narrow pane switch keeps the original iframe and unsaved review", JSON.stringify({ before: openedFrames, inTools, returned }), JSON.stringify(inTools) === JSON.stringify(openedFrames) && JSON.stringify(returned) === JSON.stringify(openedFrames));
    await user.screenshot();
  });
});
