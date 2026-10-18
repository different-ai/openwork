import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotActivity } from "../worlds/workbot-activity.ts";

const test = spec.world(workbotActivity, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member's denied conversation stays concealed through later failures until a new authorized read", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("the member can initially read the stored and streamed answer", async () => {
    await user.see({ text: "The report has three sections." });
    await user.see({ text: "The figures still need verification." });
    evidence.recordAssertionEvidence("The authorized answer is present before revocation", "Both stored and streamed words are visible", (await probe.text()).includes("The figures still need verification."));
    await user.screenshot();
  });
  await step("after: a forbidden read masks the answer and a later network failure cannot unmask it", async () => {
    world.revokeAccess();
    await user.see({ text: "Your access to this conversation couldn't be verified." });
    const before = world.reads().length;
    world.failAfterRevocation();
    await user.click({ role: "button", label: "Check again" });
    await probe.eventually(() => world.reads().slice(before).filter(read => read.status === 503).length, { within: 8000, label: "all failed read attempts actually reached the HTTP boundary", until: count => count >= 3 });
    await user.notSee({ text: "The report has three sections." });
    await user.notSee({ text: "The figures still need verification." });
    evidence.recordAssertionEvidence("A later failure does not restore denied cached content", "403 followed by three 503 reads; neither stored nor streamed words return", !(await probe.text()).includes("The report has three sections."));
    await user.screenshot();
  });
  await step("a successful HTTP unavailable response still cannot grant conversation access", async () => {
    const before = world.reads().length;
    world.unavailableAfterRevocation();
    await user.click({ role: "button", label: "Check again" });
    await probe.eventually(() => world.reads().slice(before), { within: 8000, label: "the shipped unavailable envelope is returned", until: reads => reads.some(read => read.status === 200 && JSON.stringify(read.payload).includes("workbot_runner_unavailable")) });
    await user.notSee({ text: "The report has three sections." });
    world.disabledAfterRevocation();
    await user.click({ role: "button", label: "Check again" });
    await user.notSee({ text: "The figures still need verification." });
    evidence.recordAssertionEvidence("Neither unavailable nor disabled is an authorized thread read", "HTTP 200 unavailable/disabled responses retain the denial barrier", !(await probe.text()).includes("The figures still need verification."));
    await user.screenshot();
  });
  await step("only a fresh authorized conversation read restores the answer", async () => {
    world.authorize();
    await user.click({ role: "button", label: "Check again" });
    await user.see({ text: "The report has three sections." });
    await user.see({ text: "The figures still need verification." });
    expect(world.sends()).toBe(0);
    evidence.recordAssertionEvidence("Reauthorization restores the actual conversation without replay", "An available authorized thread returns both answer parts; no message POST", world.sends() === 0);
    await user.screenshot();
  });
});

test("a workspace member's open chat attachment is concealed when conversation access is revoked", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("the member explicitly opens a conversation attachment in the workspace", async () => {
    await user.navigate(`${world.url}?workspace=on`);
    await user.click({ role: "button", label: /Report notes.txt/ });
    await user.see({ text: "Conversation attachment: quarterly figures." });
    expect((await probe.dom("[data-workbot-workspace]")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The actual workspace preview is populated before revocation", "Report notes.txt is open with its fetched text", (await probe.text()).includes("Conversation attachment: quarterly figures."));
    await user.screenshot();
  });
  await step("after: denied conversation access masks the attachment, words, and chat actions", async () => {
    world.revokeAccess();
    await user.see({ text: "Your access to this conversation couldn't be verified." });
    await user.notSee({ text: "Conversation attachment: quarterly figures." });
    await user.notSee({ role: "button", label: /Download/ });
    await user.notSee({ role: "textbox", label: "Message Workbot" });
    evidence.recordAssertionEvidence("A loaded attachment cannot outlive its conversation authorization", "The attachment preview, download action and composer DOM are concealed", !(await probe.text()).includes("Conversation attachment: quarterly figures."));
    await user.screenshot();
  });
  await step("a later failed read keeps the preview concealed until authorization is restored", async () => {
    const before = world.reads().length;
    world.failAfterRevocation();
    await user.click({ role: "button", label: "Check again" });
    await probe.eventually(() => world.reads().slice(before).filter(read => read.status === 503).length, { within: 8000, label: "the failed workspace reads were actually returned", until: count => count >= 3 });
    await user.notSee({ text: "Conversation attachment: quarterly figures." });
    world.authorize();
    await user.click({ role: "button", label: "Check again" });
    await user.see({ text: "Conversation attachment: quarterly figures." });
    evidence.recordAssertionEvidence("The preview selection is retained securely rather than discarded", "It stays hidden through failed reads and returns only after an authorized thread read", (await probe.text()).includes("Conversation attachment: quarterly figures."));
    await user.screenshot();
  });
});

test("a member keeps the last verified answer when the shipped route returns an unavailable envelope", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("the conversation is available before its runner becomes unavailable", async () => {
    await user.see({ text: "The report has three sections." });
    evidence.recordAssertionEvidence("The last verified conversation is visible", "Stored answer and task activity are on screen", (await probe.text()).includes("The report has three sections."));
    await user.screenshot();
  });
  await step("after: HTTP 200 unavailable is last-known, not an empty or removed conversation", async () => {
    world.unavailableAfterRevocation();
    await user.see({ text: /Connection interrupted\. Showing the last known conversation/ });
    await user.see({ text: "The report has three sections." });
    await user.see({ text: "Last known activity" });
    expect(world.boundary().unavailable).toEqual({ status: 200, payload: { available: false, reason: "workbot_runner_unavailable" } });
    evidence.recordAssertionEvidence("The real route's successful HTTP envelope does not overwrite the verified snapshot", JSON.stringify(world.boundary().unavailable), (await probe.text()).includes("The report has three sections."));
    await user.screenshot();
  });
  await step("checking again restores freshness without resending a prompt", async () => {
    world.authorize();
    await user.click({ role: "button", label: "Check again" });
    await probe.eventually(() => probe.text(), { within: 10000, label: "an authorized thread read restores freshness", until: text => !text.includes("Connection interrupted. Showing the last known") });
    await user.see({ text: "The report has three sections." });
    expect(world.sends()).toBe(0);
    evidence.recordAssertionEvidence("Only a read is needed for recovery", "Fresh conversation restored with zero message POSTs", world.sends() === 0);
    await user.screenshot();
  });
});

test("a member sees unconfirmed HTTP 200 stop results without an automatic retry", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("a rejected runner abort is returned by the real route as an unconfirmed stop", async () => {
    await user.see({ text: "The report has three sections." });
    await user.click({ role: "button", label: /^Stop$/ });
    await user.see({ text: "Couldn't confirm that Workbot stopped. It may still be working." });
    expect(world.boundary().stop).toEqual({ status: 200, payload: { stopped: false } });
    expect(world.stopAttempts()).toBe(1);
    evidence.recordAssertionEvidence("HTTP success does not confirm that work stopped", JSON.stringify(world.boundary().stop), world.stopAttempts() === 1);
    await user.screenshot();
  });
  await step("the background task also retains its actual state after an unconfirmed stop", async () => {
    await user.click({ role: "button", label: "Stop Review charts" });
    await user.see({ text: "Couldn't confirm this task stopped. It may still be working." });
    expect(world.boundary().taskStop).toEqual({ status: 200, payload: { stopped: false } });
    expect(world.taskStopAttempts()).toBe(1);
    evidence.recordAssertionEvidence("The task is not optimistically called stopped", JSON.stringify(world.boundary().taskStop), world.taskStopAttempts() === 1);
    await user.screenshot();
  });
  await step("only the member's explicit second stop request can produce a confirmed stop", async () => {
    await user.see({ text: "The figures still need verification." });
    expect(world.stopAttempts()).toBe(1);
    expect(world.taskStopAttempts()).toBe(1);
    await user.click({ role: "button", label: "Try stopping again", nth: 1 });
    await user.see({ text: "Stopped. This answer may be incomplete." });
    expect(world.stopAttempts()).toBe(2);
    expect(world.taskStopAttempts()).toBe(1);
    evidence.recordAssertionEvidence("No stop or prompt is silently replayed", "Exactly two explicit answer-stop requests, one task-stop request and zero message POSTs", world.stopAttempts() === 2 && world.taskStopAttempts() === 1 && world.sends() === 0);
    await user.screenshot();
  });
});
