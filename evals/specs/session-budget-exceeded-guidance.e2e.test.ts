import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionBudgetExceeded } from "../worlds/session-provider-errors.ts";

const test = spec.world(sessionBudgetExceeded, {
  timeout: 420_000,
  needs: { commands: ["pnpm", "bun"], placement: "local" },
  resources: { surfaces: ["desktop"], services: ["mock"], nativeReason: "Real isolated HTTP 400 and 429 provider responses prove budget exhaustion is terminal before a second provider attempt." },
});

test("HTTP 400 and 429 budget exhaustion are terminal and actionable", async ({ world, user, agent, probe, step, evidence }) => {
  for (let index = 0; index < world.faults.length; index += 1) {
    const fault = world.faults[index];
    const session = world.sessions[index];
    if (!fault || !session) throw new Error("Budget fixture missing");
    await agent.run("session.open", { sessionId: session.sessionId });
    await user.see("composer", { editable: true });
    if (index === 0) await step("before budget rejection", () => user.screenshot());
    await user.type("composer", fault.marker, { replace: true, verify: true });
    await user.press("Enter");
    await user.see({ text: "Provider budget exceeded" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Re-pick model" });
    expect(await probe.eval(() => document.querySelectorAll('[data-testid="session-error-repick-model"]').length)).toBe(1);
    await user.notSee({ text: /Budget has been exceeded|budget_exceeded|Retrying|at runLoop/i });
    await probe.eventually(() => world.requestCount(fault.marker), { within: 30_000, label: `one HTTP ${fault.status} budget request`, until: (count) => count === 1 });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(world.requestCount(fault.marker)).toBe(1);
    await step(`after terminal HTTP ${fault.status} budget rejection`, () => user.screenshot());
  }
  evidence.recordAssertionEvidence("Budget exhaustion never auto-retries", "The HTTP 400 phrase witness and HTTP 429 LiteLLM budget_exceeded witness each received exactly one marked request after a three-second retry window. Both conversations showed sanitized terminal guidance and Re-pick model, with no retry row.", true);
});
