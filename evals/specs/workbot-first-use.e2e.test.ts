import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotFirstUse, workbotGreetingRecovery, workbotModelGreetingRecovery } from "../worlds/workbot-first-use.ts";

const test = spec.world(workbotFirstUse, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 900_000 });
const composer = { label: "Message Workbot" };

test("a member understands Workbot and keeps chatting while a real background job runs", async ({ world, user, probe, step, evidence }) => {
  await step("before: the member has no conversation or work in progress", async () => {
    await user.navigate(world.url);
    await user.see({ text: "I'm Workbot." });
    expect(world.witness().greetingRequests).toBe(0);
    await user.screenshot();
    evidence.recordAssertionEvidence("The member sees what Workbot does before any automatic lookup", "The welcome names connected apps and longer jobs; the model has not been called.", true);
  });
  await step("the member chooses their apps before Workbot checks their day", async () => {
    await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Get started"), { within: 30_000, label: "The connection choice is ready" });
    await user.click("Get started");
    await user.see({ text: "You're all connected" });
    expect(world.witness().greetingRequests).toBe(0);
    await user.click("Start chatting");
    await user.see({ text: world.hello }, { timeoutMs: 60_000 });
    await user.see(composer, { editable: true });
    expect(world.witness().greetingWritesRejected).toBe(true);
    expect(world.witness().greetingLocalWritesRejected).toBe(true);
    expect(world.witness().tokenEscalationBlocked).toBe(true);
    expect(await world.anonymousStatus()).toBe(401);
    await user.screenshot();
    evidence.recordAssertionEvidence("The first greeting is durable and cannot change apps or memory", "The model's attempted connected-app and memory writes were rejected, the greeting is visible, and an unsigned visitor cannot read the conversation.", true);
  });
  await step("after: a job stays visible while the member asks another question", async () => {
    await user.type(composer, world.job);
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: world.title }, { timeoutMs: 60_000 });
    await user.see({ role: "button", text: "Stop" });
    await user.type(composer, "What is two plus two?");
    await user.click({ role: "button", label: "Send" });
    await probe.eventually(async () => {
      const pane = (await probe.dom(".workbot-scroll")).elements[0];
      const reply = (await probe.dom('ol[aria-label="Conversation"] > li:last-child')).elements[0];
      return !!pane && !!reply && reply.text.includes("Four.") && reply.rect.bottom <= pane.rect.bottom + 1;
    }, { label: "The latest reply stays above the pinned job", within: 30_000 });
    await user.see({ text: "Four." });
    expect(await probe.text()).toContain(world.hello);
    await user.see({ text: world.title });
    expect(world.witness().taskRequests).toBeGreaterThan(0);
    expect(world.witness().titleStayedOutOfSystem).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence("Background work is real and leaves the conversation usable", "The runner started a task; a second question was answered with the task and first greeting still visible. Task titles remained outside system instructions.", true);
  });
  await step("the finished job delivers a file and survives a reload", async () => {
    await user.see({ text: "Your launch brief is ready." }, { timeoutMs: 90_000 });
    await user.notSee({ role: "button", text: "Stop" });
    expect(JSON.stringify(await world.files())).toContain("launch-brief.md");
    await user.reload();
    await user.see({ text: world.hello });
    await user.see({ text: "Your launch brief is ready." });
    await user.notSee({ role: "button", text: "Get started" });
    await user.screenshot();
    evidence.recordAssertionEvidence("The result remains available after the job ends", "The saved launch-brief.md and completion message remain, and reload preserves the greeting without repeating onboarding.", true);
  });
  await step("the member stops another job without losing their saved result", async () => {
    await user.type(composer, world.job);
    await user.click({ role: "button", label: "Send" });
    await user.see({ role: "button", text: "Stop" }, { timeoutMs: 30_000 });
    await user.see({ text: "I'm drafting the launch brief." });
    await user.click({ role: "button", text: "Stop" });
    await user.see({ text: "Stopped" }, { timeoutMs: 30_000 });
    await user.notSee({ role: "button", text: "Stop" });
    expect(JSON.stringify(await world.thread())).toContain('"status":"stopped"');
    expect(JSON.stringify(await world.files())).toContain("launch-brief.md");
    await user.screenshot();
    evidence.recordAssertionEvidence("Stop changes the actual job state and preserves earlier work", "The runner reports stopped, the running control disappears, and the completed launch brief remains available.", true);
  });
  await step("a failed job stays visible with an honest outcome", async () => {
    await user.type(composer, "Draft another brief with the unavailable provider.");
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: "Couldn't finish" }, { timeoutMs: 60_000 });
    await user.see({ text: "I couldn't finish the brief." });
    expect(JSON.stringify(await world.thread())).toContain('"status":"failed"');
    await user.see(composer, { editable: true });
    await user.screenshot();
    evidence.recordAssertionEvidence("The UI reports failure from runner state", "The unavailable model produced a failed task and an explanation, while the conversation stayed usable.", true);
  });
  await step("the member retries the failed job from its card", async () => {
    await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Try again"), { within: 30_000, label: "The failed job can be retried" });
    await user.click({ role: "button", text: "Try again" });
    await user.see({ text: "Retry the brief" }, { timeoutMs: 30_000 });
    await user.see({ role: "button", text: "Stop" });
    await user.see({ text: "I'm trying the brief again." });
    await user.screenshot();
    evidence.recordAssertionEvidence("Retry starts a new job from the member's explicit action", "The failed card's action sent the retry request and a new runner task is visible with Stop.", true);
  });
});

const modelRecovery = spec.world(workbotModelGreetingRecovery, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 900_000 });
modelRecovery("a member retries a greeting that failed after it started", async ({ world, user, probe, step, evidence }) => {
  await step("before: the greeting starts but its model cannot answer", async () => {
    await user.navigate(world.url);
    await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Get started"), { within: 30_000, label: "The connection choice is ready" });
    await user.click("Get started");
    await user.click("Start chatting");
    await user.see({ role: "button", text: "Try again" }, { timeoutMs: 60_000 });
    expect(world.witness().rejectedGreetingModels).toBe(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("A failed greeting retains a real retry action", "The runner accepted the turn, its model failed, and the member can retry instead of sending an empty message.", true);
  });
  await step("the member retries the failed greeting", async () => {
    await user.click({ role: "button", text: "Try again" });
    await user.see({ text: world.hello }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", text: "Try again" });
    await user.screenshot();
    evidence.recordAssertionEvidence("The retry runs a fresh read-only greeting", "The failed greeting was replaced by a successful one and the attempted connected-app write was refused.", world.witness().greetingWritesRejected);
  });
  await step("after: the recovered greeting remains after reload", async () => {
    await user.reload();
    await user.see({ text: world.hello });
    await user.see(composer, { editable: true });
    expect(JSON.stringify(await world.thread()).split(world.hello)).toHaveLength(2);
    await user.screenshot();
    evidence.recordAssertionEvidence("The recovered conversation has one durable greeting", "Reload shows one greeting and a usable composer, without another onboarding screen.", true);
  });
});

const recovery = spec.world(workbotGreetingRecovery, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 900_000 });
recovery("a member retries a failed greeting without losing the conversation", async ({ world, user, probe, step, evidence }) => {
  await step("before: the runner cannot accept the member's first greeting", async () => {
    await user.navigate(world.url);
    await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Get started"), { within: 30_000, label: "The connection choice is ready" });
    await user.click("Get started");
    await user.click("Start chatting");
    await user.see({ text: "Couldn't check your day." }, { timeoutMs: 60_000 });
    await user.see(composer, { editable: true });
    expect(world.witness().rejectedStarts).toBe(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("A failed start offers recovery in a usable conversation", "The runner refused the turn after creating an empty session; the member sees Try again and can still type.", true);
  });
  await step("the member retries from the same conversation", async () => {
    await user.click({ role: "button", text: "Try again" });
    await user.see({ text: world.hello }, { timeoutMs: 60_000 });
    await user.notSee({ text: "Couldn't check your day." });
    await user.screenshot();
    evidence.recordAssertionEvidence("An existing empty session can start its greeting", "Retry reused the session and produced the greeting instead of an endless typing state.", true);
  });
  await step("after: reload keeps one greeting and no repeated welcome", async () => {
    await user.reload();
    await user.see({ text: world.hello });
    await user.notSee({ role: "button", text: "Get started" });
    expect(JSON.stringify(await world.thread()).split(world.hello)).toHaveLength(2);
    await user.screenshot();
    evidence.recordAssertionEvidence("Recovery does not duplicate the greeting", "There is one stored greeting after retry and reload, and the welcome does not return.", true);
  });
});
