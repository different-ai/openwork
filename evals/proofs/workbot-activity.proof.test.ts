import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotActivity } from "../worlds/workbot-activity.ts";

const test = spec.world(workbotActivity, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member sees unverified work, failed stop, and a last-known conversation without losing the answer", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("after: a failed computer command cannot claim it finished successfully", async () => {
    await user.see({ text: "The report has three sections." });
    await user.see({ text: "Computer work couldn't finish" }, { timeoutMs: 5000 });
    const activity = await probe.dom('[data-workbot-activity][data-running="false"]');
    expect(activity.elements.length).toBeGreaterThan(0);
    const text = await probe.text();
    expect(text).not.toMatch(/skill:|slack-calendar-report|search_capabilities|execute_capability/);
    expect((await probe.dom(".workbot-worker, .workbot-typing-dot")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Computer completion is unverified and routing details stay hidden", "The failed command says it couldn't finish; no typing person, skill id, or success check", text.includes("Computer work couldn't finish") && !text.includes("skill:"));
    await user.screenshot();
  });
  await step("a failed stop stays inline and the member explicitly tries stopping again", async () => {
    await user.click({ role: "button", label: /^Stop$/ });
    await user.see({ text: "Couldn't confirm that Workbot stopped. It may still be working." });
    await user.see({ text: "The report has three sections." });
    expect(world.stopAttempts()).toBe(1);
    evidence.recordAssertionEvidence("A stop request is not a confirmed stop", "One rejected stop; answer retained and Try stopping again is available", world.stopAttempts() === 1);
    await user.screenshot();
    await user.click({ role: "button", label: "Try stopping again" });
    await user.see({ text: "Stopped. This answer may be incomplete." });
    await user.see({ text: "The figures still need verification." });
    expect(world.stopAttempts()).toBe(2);
  });
  await step("a background task also exposes its stop failure without hiding the card", async () => {
    await user.click({ role: "button", label: "Stop Review charts" });
    await user.see({ text: "Couldn't confirm this task stopped. It may still be working." });
    await user.see({ text: "Review charts" });
    evidence.recordAssertionEvidence("The background stop has its own recovery", "One rejected task stop, retained card and answer", world.taskStopAttempts() === 1);
    await user.screenshot();
  });
  await step("a lost connection freezes live activity but keeps the last-known answer", async () => {
    world.disconnect();
    await user.see({ text: /Connection interrupted\. Showing the last known conversation, checked/ });
    await user.see({ text: "The report has three sections." });
    await user.see({ text: "Last known activity" });
    const activity = await probe.dom('[data-workbot-activity][data-running="true"]');
    expect(activity.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Cached activity is explicitly last-known", "Connection interrupted; cached text stays and no activity card is timed as running", activity.elements.length === 0);
    await user.screenshot();
  });
  await step("checking the connection recovers the same conversation without replaying a prompt", async () => {
    world.restore();
    await user.click({ role: "button", label: "Check again" });
    await user.see({ text: "The report has three sections." });
    await probe.eventually(() => probe.text(), { within: 10_000, label: "the stream and conversation read recover", until: text => !text.includes("Connection interrupted. Showing the last known") });
    await user.notSee({ text: /Connection interrupted\. Showing the last known/ });
    expect(world.sends()).toBe(0);
    evidence.recordAssertionEvidence("Recovery only reads the conversation", "No message POST occurred while stopping or reconnecting", world.sends() === 0);
    await user.screenshot();
  });
  await step("revoked access masks the cached answer instead of calling it last-known", async () => {
    world.revokeAccess();
    await user.see({ text: "Your access to this conversation couldn't be verified." });
    await user.notSee({ text: "The report has three sections." });
    await user.notSee({ text: "The figures still need verification." });
    evidence.recordAssertionEvidence("Authorization failures cannot expose the cached conversation", "A forbidden read masks both stored and streamed words", !(await probe.text()).includes("The report has three sections."));
    await user.screenshot();
  });
});

test("a member recognizes an interrupted answer without an automatic prompt replay", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("the member can read the stored and still-streaming parts of the answer", async () => {
    await user.see({ text: "The report has three sections." });
    await user.see({ text: "The figures still need verification." });
    evidence.recordAssertionEvidence("Both answer parts are on screen", "Stored report text and streamed verification text are visible", (await probe.text()).includes("The figures still need verification."));
    await user.screenshot();
  });
  await step("after: a runner interruption preserves the words and labels the answer incomplete", async () => {
    world.interruptAnswer();
    await user.see({ text: "Interrupted. This answer may be incomplete." }, { timeoutMs: 5000 });
    await user.see({ text: "The report has three sections." });
    await user.see({ text: "The figures still need verification." });
    evidence.recordAssertionEvidence("Interrupted is not running or completed", "The incomplete marker is visible and both answer parts remain", (await probe.text()).includes("Interrupted. This answer may be incomplete."));
    await user.screenshot();
  });
  await step("reopening the conversation reads its incomplete state without resending the message", async () => {
    await user.reload();
    await user.see({ text: "Interrupted. This answer may be incomplete." }, { timeoutMs: 5000 });
    await user.see({ text: "The report has three sections." });
    expect(world.sends()).toBe(0);
    evidence.recordAssertionEvidence("Reload only reads the conversation", "Zero message POSTs after interruption and reload", world.sends() === 0);
    await user.screenshot();
  });
});
