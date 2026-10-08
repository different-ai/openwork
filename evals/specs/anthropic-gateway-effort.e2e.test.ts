import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { anthropicEffort } from "../worlds/anthropic-effort.ts";

const test = spec.world(anthropicEffort, {
  timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("Anthropic gateway effort choices reach the provider and survive reload", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await user.see("composer", { editable: true });
  await step("the opaque gateway model exposes its catalog effort choices", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Effort/ });
    for (const label of ["Default", "Low", "Medium", "High", "Xhigh", "Max"]) {
      await user.see({ role: "button", label });
    }
    await user.notSee({ role: "button", label: "None" });
    await user.screenshot();
    await user.click({ role: "button", label: "Max" });
    await user.press("Escape");
  });
  for (const reload of [false, true]) {
    if (reload) await user.reload();
    await user.see({ role: "button", label: "Change model" }, { text: /Max/ });
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests(), { within: 90_000, label: "selected effort reaches Anthropic request",
      until: requests => requests.length === (reload ? 2 : 1) });
    await user.see("Run task", { timeoutMs: 30_000 });
    expect(world.requests().at(-1)).toEqual({ model: world.modelId, effort: "max" });
  }
  evidence.recordJsonArtifact("Anthropic wire requests", { engine: world.engine, requests: world.requests() });
  evidence.recordAssertionEvidence("Anthropic catalog effort survives picker, engine, and reload",
    "An opaque gateway model ID exposes only the advertised effort levels. Selecting Max sends output_config.effort=max through the pinned native engine, and the same value is sent after reload. The Anthropic endpoint is synthetic; app and engine are real.", true);
});
