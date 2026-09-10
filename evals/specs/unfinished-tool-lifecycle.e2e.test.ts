import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { arrangeControl, unfinishedTools } from "../worlds/chat.ts";

const test = spec.world(unfinishedTools);

test("unfinished current-turn tools expose Stop feedback and active, waiting, and unknown outcomes", async ({ world, user, seed, probe, step, evidence }) => {
  await step("a completed turn grounds later Stop errors in the native snapshot", async () => {
    await user.type("composer", world.warmup.prompt, { replace: true, verify: true });
    await user.press("Enter");
    await user.see({ text: world.warmup.reply }, { timeoutMs: 45_000 });
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 45_000 });
  });

  await using stopFault = await world.startStopFault();
  await step("a real native tool makes the current run stoppable", async () => {
    await probe.eventually(() => stopFault.read(), {
      within: 30_000,
      label: "the completed fixture turn in the session snapshot",
      until: (value) => value.snapshotMessageCount > 0,
    });
    await user.type("composer", world.prompt, { replace: true, verify: true });
    await user.press("Enter");
    await probe.eventually(() => world.nativeStatus(), {
      within: 45_000,
      label: "the controlled native tool run",
      until: (value) => value === "busy" || value === "retry",
    });
    await user.see({ text: /sleep 120/ }, { timeoutMs: 45_000 });
    await user.see({ role: "button", label: "Stop" }, { timeoutMs: 45_000 });
  });

  await step("Stop immediately shows bounded pending feedback without duplicate aborts", async () => {
    await user.dblclick({ role: "button", label: "Stop" });
    await user.press("Escape");
    await user.press("Escape");
    const pending = await probe.eventually(() => stopFault.read(), {
      within: 5_000,
      intervalMs: 20,
      label: "the held native Stop response and pending feedback",
      until: (value) => value.attempts === 1 && value.held === 1 && value.elapsedMs !== null,
    });
    expect(pending).toMatchObject({
      attempts: 1,
      held: 1,
      nativeStatus: null,
      nativeFailed: false,
      clickCaptured: true,
      trusted: true,
      expired: false,
      stoppingVisible: true,
      stoppingDisabled: true,
      ariaBusy: "true",
      spinnerVisible: true,
      retryEnabled: false,
      runVisible: false,
    });
    expect(pending.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(pending.elapsedMs).toBeLessThan(100);
    evidence.recordAssertionEvidence(
      "Stop shows pending UI within 100ms and suppresses duplicate mouse and keyboard attempts",
      JSON.stringify({ engine: world.engine, ...pending }),
      true,
    );
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "active" });
  await step("active unfinished tools remain visibly in progress", async () => {
    await user.see("Running command, reading 1 file");
  });

  await step("a failed Stop shows an error and restores retry without claiming completion", async () => {
    await stopFault.fail();
    const failed = await probe.eventually(() => stopFault.read(), {
      within: 5_000,
      intervalMs: 20,
      label: "failed Stop feedback and retry",
      until: (value) => value.held === 0 && value.retryEnabled && value.errorText.includes("Stop unavailable"),
    });
    expect(failed).toMatchObject({
      attempts: 1,
      held: 0,
      nativeStatus: 503,
      released: true,
      failed: true,
      stoppingVisible: false,
      retryEnabled: true,
      runVisible: false,
    });
    await user.see({ text: /Stop unavailable/ });
    expect(failed.aggregateText).not.toMatch(/\b(?:Ran command|Read brief\.md)\b/);
    evidence.recordAssertionEvidence(
      "A failed Stop remains explicitly retryable and never presents the run as completed",
      JSON.stringify(failed),
      true,
    );
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "waiting" });
  await step("a blocked unfinished step says what it needs", async () => {
    await user.see({ text: /Waiting for your action/ });
    await user.see({ text: "Choose an option or approve the request to continue." });
    await user.notSee("Running command, reading 1 file");
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "idle" });
  await step("idle unfinished tools expose an unknown terminal state", async () => {
    await user.see({ text: /Status unknown/ });
    await user.see({ text: "No terminal result was observed. This step may still be running; check the session before retrying." });
    await user.notSee({ text: /Waiting for your action/ });
    await user.notSee("Running command, reading 1 file");
  });
});
