import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionModelNotFound } from "../worlds/session-provider-errors.ts";

const test = spec.world(sessionModelNotFound, {
  timeout: 360_000,
  needs: { commands: ["pnpm", "bun"], placement: "local" },
  resources: { surfaces: ["desktop"], services: ["mock"], nativeReason: "A real isolated provider 404 must reach the Electron conversation without exposing provider diagnostics or choosing a replacement." },
});

test("a structured provider model-not-found response offers only an explicit re-pick", async ({ world, user, agent, probe, step, evidence }) => {
  const session = world.sessions[0];
  if (!session) throw new Error("Model-not-found session missing");
  const marker = world.faults[0]?.marker ?? "retired-model-proof";
  await agent.run("session.open", { sessionId: session.sessionId });
  await user.see("composer", { editable: true });
  await step("before provider model rejection", () => user.screenshot());
  await user.type("composer", marker, { verify: true });
  await user.press("Enter");
  await user.see({ text: "This model is no longer available" }, { timeoutMs: 60_000 });
  await user.see({ role: "button", label: "Re-pick model" });
  expect(await probe.eval(() => document.querySelectorAll('[data-testid="session-error-repick-model"]').length)).toBe(1);
  await user.notSee({ text: /model_not_found|requested model does not exist|at runLoop/i });
  await probe.eventually(() => world.requestCount(marker), { within: 30_000, label: "one model-not-found provider request", until: (count) => count === 1 });
  await step("after provider model retirement receives actionable guidance", () => user.screenshot());
  await user.click({ role: "button", label: "Re-pick model" });
  await user.see({ role: "button", label: "Done" });
  await step("after structured model rejection opens re-pick without selecting", () => user.screenshot());
  expect(world.requestCount(marker)).toBe(1);
  evidence.recordAssertionEvidence("Model retirement needs a structured provider signal and never auto-selects a replacement", "One HTTP 404 model_not_found witness request produced sanitized guidance and an explicit Re-pick model action. Opening it changed no model and sent no second request.", true);
});
