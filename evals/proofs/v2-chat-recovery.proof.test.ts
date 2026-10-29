import { expect } from "vitest";
import { readTranscriptMessages, spec } from "@openwork/testkit";
import { v2ChatRecovery } from "../worlds/v2-chat-recovery.ts";
import { v2StreamReconnect, streamedContinuityPrompt, streamedContinuityBullets } from "../worlds/v2-chat-reconnect.ts";

const test = spec.world(v2ChatRecovery, {
  timeout: 180_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test("RECOVERY-01 a member sees older commands finish and a missed question after reconnecting", async ({ world, user, probe, step, evidence }) => {
  await step("before: the member sees commands in progress before the connection drops", async () => {
    await user.see({ text: /Status unknown · 8 commands/ });
    await user.see({ text: "Discard this superseded answer." });
    const before = await world.recovery();
    expect(before.streams).toBe(1);
    evidence.recordAssertionEvidence("The original connection is established", JSON.stringify(before), before.streams === 1);
    await user.screenshot();
  });
  await step("after: newer answers arrive on a fresh connection", async () => {
    await world.act("catchUp");
    await world.act("interrupt");
    const connected = await probe.eventually(() => world.recovery(), {
      within: 15_000, label: "the second recovery connection", until: (value) => value.streams === 2,
    });
    await user.see({ text: "Later answer 150." }, { timeoutMs: 15_000 });
    evidence.recordAssertionEvidence("The newer answers arrive on the second connection", JSON.stringify(connected), connected.streams === 2);
    await user.screenshot();
  });
  await step("after: old commands settle even after a hundred and fifty newer answers arrived during the gap", async () => {
    const recovered = await probe.eventually(() => world.recovery(), {
      within: 15_000, label: "the eight older command results", until: (value) => value.exactReads >= 8,
    });
    await user.wheelAt({ x: 900, y: 250, deltaY: -30_000 });
    await user.click({ role: "button", label: /^Worked for/ });
    await probe.eventually(() => probe.dom('[data-tool-aggregate][data-tool-lifecycle="completed"]'), {
      within: 10_000, label: "completed command group", until: (value) => value.elements.length > 0,
    });
    await user.notSee({ text: /Status unknown/ });
    expect(recovered.recentWindow).toBe(24);
    expect(recovered.streams).toBe(2);
    expect(recovered.maxConcurrent).toBeLessThanOrEqual(4);
    await user.click({ role: "button", label: /^Ran 8 commands/ });
    await user.see({ text: /printf recovery-command-0/ });
    await user.see({ text: /printf recovery-command-7/ });
    evidence.recordAssertionEvidence("Eight older commands recover with at most four reads at once", JSON.stringify(recovered),
      recovered.exactReads >= 8 && recovered.maxConcurrent <= 4 && recovered.recentWindow === 24);
    await user.wheelAt({ x: 900, y: 200, deltaY: -30_000 });
    await probe.eventually(async () => {
      const viewport = (await probe.dom('[data-workbench-pane="primary"] [data-thread-scroll]')).elements[0]?.rect;
      const headers = (await probe.dom('[data-tool-aggregate][data-tool-lifecycle="completed"] > button')).elements;
      return Boolean(viewport && headers.some(({ rect }) => rect.top >= viewport.top && rect.bottom <= viewport.bottom));
    }, { within: 10_000, label: "the completed commands are in the screenshot", until: Boolean });
    await user.screenshot();
  });
  await step("after: the question missed during the interruption is ready without a new message or window focus", async () => {
    await user.see({ text: "Choose the report format" });
    await user.see({ text: "Outline" });
    const recovered = await world.recovery();
    expect(recovered.formReads).toBeGreaterThan(1);
    evidence.recordAssertionEvidence("The missed question returns on reconnect", JSON.stringify(recovered), recovered.formReads > 1 && recovered.streams === 2);
    await user.screenshot();
  });
});

for (const truncate of [false, true]) {
  test(`${truncate ? "REVERT-01" : "REMOVAL-01"} a member's ${truncate ? "reverted" : "removed"} answer stays gone when a delayed read returns`, async ({ world, user, probe, step, evidence }) => {
    await step("before: an answer is visible while its recovery read is held", async () => {
      await user.see({ text: "Discard this superseded answer." });
      await world.act("hold");
      const held = await probe.eventually(() => world.recovery(), {
        within: 10_000, label: "the delayed native answer read", until: (value) => value.held === 1,
      });
      evidence.recordAssertionEvidence("An older native response is held", JSON.stringify(held), held.held === 1);
      await user.screenshot();
    });
    await step(`the answer disappears when its ${truncate ? "revert commits" : "removal arrives"}`, async () => {
      await world.remove(truncate);
      await probe.eventually(() => probe.text(), { within: 5_000, label: "the answer is removed", until: (text) => !text.includes("Discard this superseded answer.") });
      await user.notSee({ text: "Discard this superseded answer." });
      const text = await probe.text();
      evidence.recordAssertionEvidence("The discarded answer disappears", "The chat no longer contains the discarded answer.", !text.includes("Discard this superseded answer."));
      await user.screenshot();
    });
    await step("after: returning the old response cannot restore the discarded answer", async () => {
      await world.act("release");
      const released = await probe.eventually(() => world.recovery(), { within: 5_000, label: "the late response returned", until: (value) => value.released === 1 });
      await user.notSee({ text: "Discard this superseded answer." }, { timeoutMs: 1_000 });
      const text = await probe.text();
      evidence.recordAssertionEvidence("Returning the late response cannot restore the answer", JSON.stringify(released),
        released.released === 1 && !text.includes("Discard this superseded answer."));
      await user.screenshot();
    });
  });
}

test("HEARTBEAT-01 a member keeps one healthy quiet connection and recovers a silent one", async ({ world, user, probe, step, evidence }) => {
  await step("before: the chat is connected with only keep-alive comments arriving", async () => {
    await user.see({ text: "Discard this superseded answer." });
    const initial = await world.recovery();
    expect(initial.streams).toBe(1);
    evidence.recordAssertionEvidence("The quiet connection is established", JSON.stringify(initial), initial.streams === 1);
    await user.screenshot();
  });
  await step("after: keep-alive traffic preserves the connection beyond the thirty-second stale threshold", async () => {
    const quiet = await probe.eventually(() => world.recovery(), {
      within: 45_000, intervalMs: 500, label: "forty seconds of healthy quiet traffic",
      until: (value) => value.now - value.connectedAt >= 40_000,
    });
    await user.see({ text: "Discard this superseded answer." });
    expect(quiet.streams).toBe(1);
    expect(quiet.comments).toBeGreaterThanOrEqual(35);
    evidence.recordAssertionEvidence("Keep-alive bytes preserve the healthy connection", JSON.stringify(quiet), quiet.streams === 1 && quiet.comments >= 35);
  });
  await step("a connection that stops receiving bytes still reconnects automatically", async () => {
    await world.act("silence");
    const dead = await probe.eventually(() => world.recovery(), {
      within: 45_000, intervalMs: 500, label: "the silent connection is replaced", until: (value) => value.streams === 2,
    });
    await user.see({ text: "Discard this superseded answer." });
    evidence.recordAssertionEvidence("A transport without bytes reconnects", JSON.stringify(dead), dead.streams === 2);
    await user.screenshot();
  });
});

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const normalizedLines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean).join("\n");

const reconnectTest = spec.world(v2StreamReconnect, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

reconnectTest("RECONNECT-01 a member sees tools finish and an answer keep growing after reconnecting", async ({ world, user, probe, step, evidence }) => {
  const stop = { role: "button", label: "Stop" } as const;
  const reconnect = async () => {
    const before = await world.engineHttpEvents();
    await world.continuity.reconnectEvents();
    const after = await probe.eventually(() => world.engineHttpEvents(), {
      within: 15_000, intervalMs: 100, label: "a new event connection after the network interruption",
      until: (value) => value.streams > before.streams,
    });
    expect(after.streams).toBeGreaterThan(before.streams);
  };
  await step("before: a member sees a command running on the original connection", async () => {
    await user.type("composer", streamedContinuityPrompt);
    await user.click("Run task");
    await user.see({ text: /sleep 15/ }, { timeoutMs: 60_000 });
    await user.see(stop);
    const connected = await world.engineHttpEvents();
    evidence.recordAssertionEvidence("A command is running on the original connection", `Connections: ${connected.streams}; the command and Stop are visible.`, connected.streams > 0);
    await user.screenshot();
  });
  await step("after: the command finishes on a new connection while the answer is still running", async () => {
    await reconnect();
    await user.see({ text: streamedContinuityBullets[0] }, { timeoutMs: 45_000 });
    const tools = await probe.eventually(() => probe.dom('[data-tool-aggregate][data-tool-lifecycle="completed"]'), {
      within: 10_000, label: "the command result without another message", until: (value) => value.elements.length > 0,
    });
    expect(tools.elements.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("The command finishes after reconnecting", `Completed command groups: ${tools.elements.length}`, tools.elements.length > 0);
    await user.notSee({ text: /Status unknown/ });
    await user.see(stop);
    await user.screenshot();
  });
  await step("after: the same answer keeps growing after another interruption without a follow-up", async () => {
    await reconnect();
    await world.releaseReply();
    await user.see({ text: streamedContinuityBullets[1] }, { timeoutMs: 15_000 });
    await user.see({ text: streamedContinuityBullets[0] });
    await user.see(stop);
    await world.releaseReply(10);
    await user.see({ text: streamedContinuityBullets[9] }, { timeoutMs: 30_000 });
    await user.see("Run task", { timeoutMs: 15_000 });
    const messages = await readTranscriptMessages(probe, "assistant");
    const text = normalizedLines(messages.join("\n"));
    for (const bullet of streamedContinuityBullets) expect(occurrences(text, bullet)).toBe(1);
    const requests = await world.engineHttpEvents();
    expect(requests.promptPosts).toEqual({ [world.session.sessionId]: 1 });
    evidence.recordAssertionEvidence("One prompt produces the complete answer across two interruptions", JSON.stringify(requests.promptPosts),
      requests.promptPosts[world.session.sessionId] === 1 && streamedContinuityBullets.every(bullet => occurrences(text, bullet) === 1));
    expect(await readTranscriptMessages(probe, "user")).toHaveLength(1);
    await user.notSee({ text: /Status unknown/ });
    await user.screenshot();
  });
});

