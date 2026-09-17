import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionDenDisconnected } from "../worlds/session-provider-errors.ts";

const test = spec.world(sessionDenDisconnected, {
  timeout: 480_000,
  needs: { commands: ["pnpm", "bun"], placement: "local" },
  resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "A signed-in isolated Electron loses its fault-proxied Den session while a cloud-keyed provider witness rejects the active request." },
});

test("a retained Den session outage shows Reconnect instead of provider internals", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await user.see("composer", { editable: true });
  await step("before disconnected Den provider rejection", () => user.screenshot());
  await user.type("composer", world.marker, { verify: true });
  await user.press("Enter");
  await probe.eventually(() => world.requestCount(), { within: 30_000, label: "one disconnected provider request", until: (count) => count === 1 });
  await world.disconnectDen();
  await user.reload();
  await user.see({ text: /OpenWork Cloud is temporarily unavailable/i }, { timeoutMs: 60_000 });
  await user.see({ text: "OpenWork Cloud is disconnected" }, { timeoutMs: 60_000 });
  await user.see({ role: "button", label: "Reconnect" });
  expect(await probe.eval(() => document.querySelectorAll('[data-testid="session-error-reconnect-den"]').length)).toBe(1);
  await user.notSee({ text: /unauthorized|Provider authentication failed|Retrying|at runLoop/i });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(world.requestCount()).toBe(1);
  await step("after Den outage receives actionable reconnect guidance", () => user.screenshot());
  evidence.recordAssertionEvidence("Den outage is distinct and terminal", "A retained signed-in session failed its live Den read through the fault proxy. The cloud-keyed provider witness received one marked request, and the conversation showed Reconnect without provider text, stack output, or a retry row.", true);
});
