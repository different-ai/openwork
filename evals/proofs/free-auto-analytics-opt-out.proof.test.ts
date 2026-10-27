import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { freeAutoAnalyticsOptOutWorld } from "../worlds/free-auto-analytics-opt-out.ts";

const test = spec.world(freeAutoAnalyticsOptOutWorld, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"],
    services: [],
    nativeReason: "Free Auto's relay and its Gateway requests run only in the desktop runtime's local server, which the app in a browser does not start.",
  },
});

const JOURNEY = /^[a-f0-9]{64}$/;
const SWITCH_ON = '[role="switch"][aria-label="Share anonymous usage data"][aria-checked="true"]';
const SWITCH_OFF = '[role="switch"][aria-label="Share anonymous usage data"][aria-checked="false"]';

test("a person who turns off usage data stops free Auto from sending its analytics identifier", async ({ world, user, probe, step, evidence }) => {
  let firstJourney: string | null = null;

  await step("with usage data on, free Auto's Gateway checks carry a random analytics identifier", async () => {
    await world.openPreferences();
    await user.see({ role: "switch", label: "Share anonymous usage data" }, { timeoutMs: 60_000 });
    // The app reports its setting to the local server after start; the next check reflects it.
    const sent = await probe.eventually(async () => {
      await world.checkFreeAuto();
      return (await world.gatewayRequests()).at(-1) ?? null;
    }, { within: 30_000, until: (request) => typeof request?.journey === "string", label: "status check with usage data on" });
    firstJourney = sent?.journey ?? null;
    const ok = typeof firstJourney === "string" && JOURNEY.test(firstJourney);
    evidence.recordAssertionEvidence("Analytics on: the identifier is sent", `last status request ${sent?.path}; identifier ${ok ? "present (64 hex characters)" : "missing"}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("the person turns off Share anonymous usage data in Settings → Preferences", async () => {
    await user.click({ role: "switch", label: "Share anonymous usage data" });
    await probe.eventually(() => probe.dom(SWITCH_OFF), { within: 10_000, until: (value) => value.elements.length === 1, label: "usage data switched off" });
    await user.screenshot();
  });

  await step("after: free Auto's Gateway checks no longer carry an analytics identifier", async () => {
    const before = (await world.gatewayRequests()).length;
    const checked = await probe.eventually(async () => {
      const result = await world.checkFreeAuto();
      return { result, request: (await world.gatewayRequests()).at(-1) ?? null };
    }, { within: 30_000, until: (value) => value.request !== null && value.request.journey === null, label: "status check with usage data off" });
    const requests = await world.gatewayRequests();
    const ok = checked.result.state === "ready" && requests.length > before && requests.at(-1)?.journey === null;
    evidence.recordAssertionEvidence("Analytics off: no identifier leaves the device", `free Auto still answers "${checked.result.state}"; latest of ${requests.length} Gateway checks has no identifier`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("turning usage data back on starts a new identifier that cannot be linked to the old one", async () => {
    await user.click({ role: "switch", label: "Share anonymous usage data" });
    await probe.eventually(() => probe.dom(SWITCH_ON), { within: 10_000, until: (value) => value.elements.length === 1, label: "usage data switched on" });
    const sent = await probe.eventually(async () => {
      await world.checkFreeAuto();
      return (await world.gatewayRequests()).at(-1) ?? null;
    }, { within: 30_000, until: (request) => typeof request?.journey === "string", label: "status check after opting back in" });
    const next = sent?.journey ?? null;
    const ok = typeof next === "string" && JOURNEY.test(next) && next !== firstJourney;
    evidence.recordAssertionEvidence("Opting back in does not resume the old identity", `new identifier ${ok ? "differs from the one sent before opting out" : "matches the old one or is missing"}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
