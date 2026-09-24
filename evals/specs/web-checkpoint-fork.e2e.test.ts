import { spec, registerScreenshotCheckpoint } from "@openwork/testkit";
import { expect } from "vitest";
import { checkpointWorld } from "../worlds/web-checkpoint.ts";

const test = spec.world(async () => {
  const world = await checkpointWorld();
  const unregister = registerScreenshotCheckpoint(world.app, world.capture);
  return { ...world, async [Symbol.asyncDispose]() { unregister(); await world[Symbol.asyncDispose](); } };
}, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { placement: "local", env: ["FREESTYLE_API_KEY"], optIn: ["OPENWORK_EVIDENCE_CHECKPOINTS"] },
  timeout: 1_200_000,
});

const partial = "This response is paused at the saved checkpoint.";
const remaining = "The same response continued from the saved browser.";

test("a reviewer enters a saved web browser with ten sessions and continues a paused response", { timeout: 1_200_000 }, async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: an ordinary screenshot creates no interactive checkpoint", async () => {
    await user.see("composer", { editable: true });
    const picture = await user.screenshot({ checkpoint: false });
    expect(picture.checkpoint).toBeUndefined();
    evidence.recordAssertionEvidence("Capture is explicitly optional", "The opt-out image has no checkpoint reference.", true);
  });

  const sessions = await step("the owner creates ten named sessions and saves the browser", async () => {
    for (let index = 1; index <= 10; index++) await agent.createSession(`Checkpoint session ${String(index).padStart(2, "0")}`);
    const list = await agent.list();
    expect(list.filter((entry) => entry.title.startsWith("Checkpoint session "))).toHaveLength(10);
    await user.see({ text: "Checkpoint session 10" });
    const picture = await user.screenshot();
    expect(picture.checkpoint?.sourceSha).toBe(world.sourceSha);
    evidence.recordAssertionEvidence("Ten real OpenWork sessions are saved", "The product session list contains all ten named sessions; screenshot and checkpoint identify this source commit.", true);
    return world.publish(picture, "Ten saved sessions");
  });

  const streaming = await step("the owner saves a response while its original stream is still open", async () => {
    await agent.send("Show a checkpoint demonstration");
    await user.see({ text: partial }, { timeoutMs: 120_000 });
    const state = await world.streamState();
    expect(state).toEqual({ held: true, complete: false, streamCount: 1 });
    const picture = await user.screenshot();
    expect(picture.checkpoint).toBeDefined();
    evidence.recordAssertionEvidence("The risky condition occurred", "One real app-to-mock stream is held after partial text; it has not completed or reconnected.", true);
    return world.publish(picture, "Paused response");
  });

  await step("the original response completes and its entire test VM is removed", async () => {
    await world.continueStream();
    await user.see({ text: remaining }, { timeoutMs: 60_000 });
    await user.screenshot({ checkpoint: false });
    await world.stop();
    evidence.recordAssertionEvidence("Forks cannot depend on the original VM", "The original response completed, then the owning VM was deleted before either review launch.", true);
  });

  const reviewUser = user.on(world.reviewer);
  const reviewProbe = probe.on(world.reviewer);
  await step("after: clicking the saved sessions image opens an independent browser", async () => {
    await reviewUser.navigate(sessions.url);
    await reviewUser.click({ role: "link", label: "Inspect Ten saved sessions" });
    await reviewUser.see({ role: "button", text: "Open from here" });
    await reviewUser.click({ role: "button", text: "Open from here" });
    await reviewUser.see({ role: "link", text: "Enter saved browser" }, { timeoutMs: 90_000 });
    await reviewUser.screenshot();
    const fork = await world.openedFork(sessions.id);
    await user.on(fork.app).see({ text: "Checkpoint session 10" });
    expect((await agent.on(fork.app).list()).filter((entry) => entry.title.startsWith("Checkpoint session "))).toHaveLength(10);
    await user.on(fork.app).screenshot();
    evidence.recordAssertionEvidence("The review action restores product state", "The actual launch route created a private fork; its restored browser lists ten sessions after the source VM was deleted.", true);
  });

  await step("after: the paused screenshot opens at partial text and continues the same response", async () => {
    await reviewUser.navigate(streaming.url);
    await reviewUser.click({ role: "link", label: "Inspect Paused response" });
    await reviewUser.click({ role: "button", text: "Open from here" });
    await reviewUser.see({ role: "link", text: "Enter saved browser" }, { timeoutMs: 90_000 });
    await reviewUser.screenshot();
    const fork = await world.openedFork(streaming.id);
    await user.on(fork.app).see({ text: partial });
    expect(await probe.on(fork.app).text()).not.toContain(remaining);
    expect(await fork.streamState()).toEqual({ held: true, complete: false, streamCount: 1 });
    await user.on(fork.app).screenshot();
    const viewer = user.on(world.viewer);
    await viewer.navigate(fork.viewerUrl);
    await viewer.see({ role: "button", text: "Continue response" });
    await viewer.screenshot();
    await viewer.click({ role: "button", text: "Continue response" });
    await user.on(fork.app).see({ text: remaining }, { timeoutMs: 60_000 });
    expect(await fork.streamState()).toEqual({ held: false, complete: true, streamCount: 1 });
    await user.on(fork.app).screenshot();
    evidence.recordAssertionEvidence("The saved partial response continues", "The restored tab showed partial text before release, then received the remaining response without a reload.", true);
  });

  await step("a different origin cannot spend checkpoint quota through the review session", async () => {
    const response = await fetch(`${world.reviewUrl}/r/${streaming.id}/checkpoint/image`, {
      method: "POST", headers: { origin: "https://unrelated.example", "content-type": "application/json" }, body: JSON.stringify({ requestId: "0".repeat(36) }),
    });
    expect(response.status).toBe(403);
    await reviewUser.see({ role: "link", text: "Enter saved browser" });
    expect((await reviewProbe.dom(".viewer-context a.preview-open")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Cross-origin launch is refused", "The launch endpoint returned HTTP 403 while the authorized review kept its existing saved-browser link.", true);
    await reviewUser.screenshot();
  });
});
