import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appConnectionErrorsWorld, MCP_PROMPT, MCP_REPLY, APP_CONNECTION_ERROR } from "../worlds/app-connection-errors.ts";

const test = spec.world(appConnectionErrorsWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 480_000,
});

test("a member gets compact App connection errors in OpenCode v2 without enabling a feature", async ({ world, user, probe, step, evidence }) => {
  await step("after: an unavailable App view stays compact while the completed report remains readable", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", MCP_PROMPT);
    await probe.eventually(() => probe.dom('button[aria-label="Run task"]:not(:disabled)'), {
      within: 30_000, label: "the conversation is ready to run the task", until: (value) => value.elements.length === 1,
    });
    await user.click("Run task");
    await user.see({ text: MCP_REPLY }, { timeoutMs: 90_000 });
    await user.see({ text: "View unavailable" }, { timeoutMs: 30_000 });
    await user.see("Retry view");
    await user.notSee({ text: new RegExp(APP_CONNECTION_ERROR) });
    const calls = await world.toolCalls();
    expect(calls.filter(call => call.name === "read_report")).toHaveLength(1);
    expect(calls.filter(call => call.name === "update_note")).toHaveLength(1);
    const counts = await world.counts();
    expect(counts.views).toBeGreaterThan(0);
    expect(counts.probes).toBe(0);
    evidence.recordAssertionEvidence("Compact App errors work without a rollout and preserve actual tool outcomes", JSON.stringify({ calls: calls.map(call => call.name), counts }), counts.views > 0 && counts.probes === 0 && calls.length === 2);
    await user.screenshot();
  });

  await step("technical details remain available on request", async () => {
    await user.click({ text: "Technical details" });
    await user.see({ text: new RegExp(APP_CONNECTION_ERROR) });
    const details = await probe.dom("details[open] pre");
    const ok = details.elements.some(element => element.text.includes(APP_CONNECTION_ERROR));
    evidence.recordAssertionEvidence("The connection diagnostic is preserved behind Technical details", JSON.stringify(details.elements.map(element => element.text)), ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("retrying the view never repeats the tool call or restarts the task", async () => {
    const before = await world.counts();
    await user.click("Retry view");
    await probe.eventually(() => world.counts(), {
      within: 15_000, label: "the view is read again", until: (value) => value.views > before.views,
    });
    await user.see("Retry view", { timeoutMs: 30_000 });
    const after = await world.counts();
    const calls = await world.toolCalls();
    expect(calls).toHaveLength(2);
    expect(after.prompts).toBe(before.prompts);
    expect(after.stops).toBe(0);
    evidence.recordAssertionEvidence("Retry view reloads only the view, with no tool replay, new prompt, or task stop", JSON.stringify({ before, after, tools: calls.map(call => call.name) }), calls.length === 2 && after.prompts === before.prompts && after.stops === 0);
    await user.screenshot();
  });

  await step("an offline browser hint leaves the draft and Send usable without a separate indicator", async () => {
    await world.offline(true);
    await user.notSee({ text: "You’re offline" });
    await user.type("composer", "Check whether the client note was saved.");
    await user.see("composer", { text: "Check whether the client note was saved." });
    await user.see("Retry view");
    const notices = await probe.dom('[data-testid="offline-recovery"]');
    const send = await probe.dom('button[aria-label="Run task"]:not(:disabled)');
    const ok = notices.elements.length === 0 && send.elements.length === 1;
    evidence.recordAssertionEvidence("No separate offline indicator appears or blocks the draft and Send", JSON.stringify({ indicators: notices.elements.length, readyToSend: send.elements.length }), ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("reconnecting leaves recovery with OpenCode v2 and never replays the timed-out action", async () => {
    const before = await world.counts();
    await world.offline(false);
    await user.notSee({ text: "You’re offline" });
    await user.notSee({ text: "Connection restored" });
    await user.see("composer", { text: "Check whether the client note was saved." });
    const after = await world.counts();
    const calls = await world.toolCalls();
    expect(after.prompts).toBe(before.prompts);
    expect(after.stops).toBe(0);
    expect(after.probes).toBe(0);
    expect(calls).toHaveLength(2);
    evidence.recordAssertionEvidence("Network recovery does not replay the timed-out action", JSON.stringify({ before, after, tools: calls.length }), after.prompts === before.prompts && after.stops === 0 && calls.length === 2);
    await user.screenshot();
  });
});
