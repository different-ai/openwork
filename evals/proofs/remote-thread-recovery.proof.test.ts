import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { remoteThreadRecovery } from "../worlds/remote-thread-recovery.ts";

const test = spec.world(remoteThreadRecovery, { timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den"] } });

test("a member keeps the next draft and sees the same confirmed remote task state in the row and conversation", async ({ world, user, probe, step, evidence }) => {
  await step("the remote task stays in chat until the member opens its conversation", async () => {
    await user.click({ text: world.session.title });
    await user.reload();
    await user.see({ role: "button", label: `${world.title}. Open the task on Project computer` }, { timeoutMs: 45_000 });
    const panels = (await probe.dom("[data-remote-thread-panel]")).elements.length;
    expect(panels).toBe(0);
    evidence.recordAssertionEvidence("A remote result never opens a panel by itself", `open remote panels: ${panels}`, panels === 0);
    await user.screenshot();
  });
  await step("the member reads real task updates without losing their place or focus", async () => {
    await user.click({ role: "button", label: `${world.title}. Open the task on Project computer` });
    await user.see({ text: "Section 17 checked. The project notes remain available for review." }, { timeoutMs: 45_000 });
    await user.see({ text: /Conversation checked/ });
    const transcript = (await probe.dom("[data-remote-thread-transcript]")).elements[0];
    if (!transcript) throw new Error("Missing remote conversation");
    await user.wheelAt({ x: transcript.rect.left + transcript.rect.width / 2, y: transcript.rect.top + transcript.rect.height / 2, deltaY: -3_000 });
    await user.see({ role: "button", label: "Show earlier messages" });
    const anchorBefore = (await probe.dom('[data-remote-thread-message="user"]')).elements.find((element) => element.text === "Review section 3")?.rect.top;
    if (anchorBefore === undefined) throw new Error("Missing the reader's first visible turn");
    await user.click({ role: "button", label: "Show earlier messages" });
    await probe.eventually(async () => (await probe.dom('[data-remote-thread-message="user"]')).elements.some((element) => element.text === "Review section 1"), { within: 15_000, intervalMs: 200, label: "earlier task messages arrive", until: Boolean });
    const anchorAfter = (await probe.dom('[data-remote-thread-message="user"]')).elements.find((element) => element.text === "Review section 3")?.rect.top;
    expect(anchorAfter).toBeDefined();
    expect(Math.abs((anchorAfter ?? 0) - anchorBefore)).toBeLessThan(3);
    const positions: number[] = [];
    await probe.eventually(async () => {
      const line = (await probe.dom("[data-remote-thread-status]")).elements[0];
      if (line) positions.push(line.rect.top);
      return positions.length;
    }, { within: 5_000, intervalMs: 500, label: "sample the quiet remote status line", until: (count) => count >= 6 });
    const jumps = positions.slice(1).filter((position, index) => position < (positions[index] ?? position) - 1).length;
    expect(jumps).toBe(0);
    evidence.recordAssertionEvidence("Quiet task updates do not pull the status line upward", `measure-chat-flicker: ${positions.length} samples, ${jumps} upward jumps`, jumps === 0);
    await user.screenshot();
  });
  await step("after: a slow follow-up preserves the next editable draft instead of clearing it on receipt", async () => {
    await user.type({ role: "textbox", label: "Follow up" }, "Summarize section 17.");
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: "Sending…" });
    await user.type({ role: "textbox", label: "Follow up" }, "Keep this next draft.");
    world.releaseFollowUp();
    await user.see({ text: "Sent · waiting for the conversation" }, { timeoutMs: 10_000 });
    await user.see({ role: "textbox", label: "Follow up" }, { value: "Keep this next draft." });
    const counts = world.counts();
    expect(counts.sends).toBe(1);
    evidence.recordAssertionEvidence("Only the submitted text was sent and the next draft remains", `${counts.sends} remote sends; next draft: Keep this next draft.`, counts.sends === 1);
    await user.screenshot();
  });
  await step("a next draft survives closing the panel while its submitted follow-up is rejected", async () => {
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: "Sending…" });
    await user.type({ role: "textbox", label: "Follow up" }, "Draft survives switching and reopening.");
    await user.hover({ role: "button", label: `Select tab: ${world.title}` });
    await user.click({ role: "button", label: `Close tab: ${world.title}` });
    world.releaseFollowUp(true);
    await probe.eventually(() => world.counts().rejectedSends, { within: 10_000, intervalMs: 100, label: "the pending follow-up is rejected while its panel is closed", until: (count) => count === 1 });
    await user.click({ role: "button", label: `${world.title}. Open the task on Project computer` });
    await user.see({ text: "The computer refused this follow-up. Review it before trying again." });
    await user.see({ role: "textbox", label: "Follow up" }, { value: "Draft survives switching and reopening." });
    const counts = world.counts();
    expect(counts.sends).toBe(2); expect(counts.rejectedSends).toBe(1);
    evidence.recordAssertionEvidence("The next draft and failed submitted message belong to the conversation, not the panel mount", `send attempts: ${counts.sends}; rejected attempts: ${counts.rejectedSends}; draft retained after reopening`, counts.sends === 2 && counts.rejectedSends === 1);
    await user.screenshot();
  });
  await step("a rejected Stop stays visible in both the task row and its open conversation", async () => {
    await user.click({ role: "button", label: `${world.title}. Stop the task`, nth: 0 });
    await user.see({ text: "The computer refused Stop. Try again when it reconnects.", nth: 0 }, { timeoutMs: 10_000 });
    const row = (await probe.dom("[data-remote-thread]")).elements[0]?.text ?? "";
    const panel = (await probe.dom("[data-remote-thread-panel]")).elements[0]?.text ?? "";
    expect(row).toContain("refused Stop"); expect(panel).toContain("refused Stop");
    evidence.recordAssertionEvidence("Stop failure is shared, not discarded or called Stopped", `row reports failure: ${row.includes("refused Stop")}; panel reports failure: ${panel.includes("refused Stop")}`, row.includes("refused Stop") && panel.includes("refused Stop"));
    await user.screenshot();
  });
  await step("a failed receipt read stays recoverable and checking the known receipt never repeats Stop", async () => {
    world.pendingStop();
    await user.click({ role: "button", label: `${world.title}. Stop the task`, nth: 0 });
    await user.see({ text: /Stop not confirmed · task may still be running/, nth: 0 }, { timeoutMs: 90_000 });
    const before = world.counts();
    world.acceptStop();
    await user.click({ role: "button", label: "Check again", nth: 0 });
    await user.see({ text: "Stop requested · waiting for the task", nth: 0 });
    const after = world.counts();
    expect(after.stops).toBe(before.stops);
    expect(after.failedReceiptReads).toBe(1);
    expect(after.receiptReads).toBeGreaterThan(before.receiptReads);
    await user.notSee({ text: "Stopped" });
    expect(after.statuses).toBeLessThan(20);
    evidence.recordAssertionEvidence("Requested is not Stopped and the bounded follower stays quiet", `Stop calls before/after checking: ${before.stops}/${after.stops}; status calls: ${after.statuses}`, after.stops === before.stops && after.statuses < 20);
    await user.screenshot();
  });
  await step("a failed freshness check keeps the last known task, then a confirmed interruption settles it", async () => {
    world.disconnect();
    await user.see({ text: /Couldn't verify · Last checked/, nth: 0 }, { timeoutMs: 15_000 });
    await user.see({ role: "textbox", label: "Follow up" }, { value: "Draft survives switching and reopening." });
    await user.screenshot();
    world.reconnect(); world.settle();
    await user.see({ text: "Stopped", nth: 0 }, { timeoutMs: 30_000 });
    const counts = world.counts();
    evidence.recordAssertionEvidence("Only authoritative task state confirms Stopped", `remote sends: ${counts.sends}; Stop requests: ${counts.stops}; row and panel now show Stopped`, counts.sends === 2 && counts.stops === 2);
    await user.screenshot();
  });
});
