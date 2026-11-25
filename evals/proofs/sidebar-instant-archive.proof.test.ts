import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sidebarInstantArchive } from "../worlds/sidebar-instant-archive.ts";

const test = spec.world(sidebarInstantArchive, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] } });

test("a person sees a chat leave the sidebar immediately and gets it back if the archive fails", async ({ world, user, probe, step, evidence }) => {
  const row = (id: string) => ({ testId: `sidebar-session-${id}` });
  const count = async (id: string) => (await probe.dom(`[data-sidebar-session-id="${id}"]:not([data-global-archived-sessions] *)`)).elements.filter(element => element.rect.height > 0).length;
  const archive = row(world.archive.sessionId);
  const keep = row(world.keep.sessionId);
  await user.resizeViewport({ width: 1280, height: 850, deviceScaleFactor: 1 });

  await step("before: both chats are in the sidebar", async () => {
    await user.see(archive, { timeoutMs: 45_000 });
    await user.see(keep);
    await user.click(archive);
    await probe.eventually(() => probe.hash(), { within: 10_000, label: "the checklist opens", until: hash => hash.includes(world.archive.sessionId) });
    const counts = await Promise.all([count(world.archive.sessionId), count(world.keep.sessionId)]);
    evidence.recordAssertionEvidence("Both chats are visible", `Active rows for the checklist and offsite: ${counts.join(", ")}.`, counts.join() === "1,1");
    expect(counts).toEqual([1, 1]);
    await user.screenshot();
  });

  // Record rather than throw now so the base run also captures recovery.
  let countWhileHeld = -1;
  let leftWhileHeld = false;
  await step("after: the selected chat closes and leaves the sidebar before the archive write can finish", async () => {
    await user.rightClick(archive);
    await user.click({ role: "menuitem", label: "Archive session" });
    await probe.eventually(() => world.gate.isHeld(), { within: 4_000, label: "the archive write is held before reaching the engine", until: Boolean });
    countWhileHeld = await count(world.archive.sessionId);
    const keepCount = await count(world.keep.sessionId);
    leftWhileHeld = !(await probe.hash()).includes(world.archive.sessionId);
    evidence.recordAssertionEvidence("Only the selected chat closes and disappears while the write is held", `Archive write paused before reaching engine; checklist rows=${countWhileHeld}; offsite rows=${keepCount}; left checklist route=${leftWhileHeld}.`, countWhileHeld === 0 && keepCount === 1 && leftWhileHeld);
    await user.screenshot();
    expect(keepCount).toBe(1);
  });

  await step("after: a failed archive restores the chat and offers a visible error", async () => {
    await world.gate.reject();
    await user.see({ text: "Couldn't archive session" }, { timeoutMs: 10_000 });
    await user.see(archive);
    await user.see(keep);
    const counts = await Promise.all([count(world.archive.sessionId), count(world.keep.sessionId)]);
    await probe.eventually(() => probe.hash(), { within: 10_000, label: "the checklist route is restored", until: hash => hash.includes(world.archive.sessionId) });
    evidence.recordAssertionEvidence("The failed archive restores the selected chat and reports the error", `The held request returned HTTP 503; the error toast is visible; the checklist is selected again; active rows for the checklist and offsite: ${counts.join(", ")}.`, counts.join() === "1,1");
    expect(counts).toEqual([1, 1]);
    await user.screenshot();
  });
  expect({ countWhileHeld, leftWhileHeld }, "the selected chat should close before the archive write is released").toEqual({ countWhileHeld: 0, leftWhileHeld: true });
});
