import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { updaterChannelWorld } from "../worlds/first-run.ts";

const test = spec.world(updaterChannelWorld, { needs: { placement: "local" }, timeout: 120_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("the macOS updater keeps an Alpha selection through a stale check and relaunch", async ({ world, user, seed, probe, step }) => {
  // TODO(primitive): read updater checks, persisted preference, and native channel state.
  const readSnapshot = (target: typeof probe) => target.eval(`(async () => {
    const state = window.__openworkUpdaterEvalState;
    const native = await window.__OPENWORK_ELECTRON__.updater.getChannel();
    const preferences = JSON.parse(localStorage.getItem("openwork.preferences") || "null");
    return { checks: state.checks, setChannels: state.setChannels, nativeChannel: native.channel,
      preferenceChannel: preferences?.releaseChannel, pickerText: document.querySelector('[aria-label="Release channel"]')?.textContent ?? "",
      pageText: document.body.innerText };
  })()`, { awaitPromise: true });
  // TODO(primitive): observe whether the controlled updater check has started.
  await probe.eventually(
    () => probe.eval(`window.__openworkUpdaterEvalState?.stableStarted === true`),
    { within: 30_000, label: "initial Stable update check in flight", until: (value) => value === true },
  );
  await user.click({ label: "Release channel" });
  await user.click("Alpha");

  // TODO(primitive): resolve a controlled stale updater response.
  await seed.evalIn(world.app, `window.__openworkUpdaterEvalState.finishStable()`);
  const afterRace = await probe.eventually(
    () => readSnapshot(probe),
    { within: 30_000, label: "Alpha survives stale Stable response", until: (value) => isRecord(value) && value.nativeChannel === "alpha" },
  );
  const checks = isRecord(afterRace) && Array.isArray(afterRace.checks) ? afterRace.checks : [];
  expect(checks[0]).toBe("stable");
  expect(checks).toContain("alpha");
  expect(checks.at(-1)).toBe("alpha");
  expect(isRecord(afterRace) ? afterRace.setChannels : []).toContain("alpha");
  expect(isRecord(afterRace) ? afterRace.nativeChannel : null).toBe("alpha");
  expect(isRecord(afterRace) ? afterRace.preferenceChannel : null).toBe("alpha");
  expect(isRecord(afterRace) ? afterRace.pickerText : "").toContain("Alpha");
  expect(isRecord(afterRace) ? afterRace.pageText : "").toContain("You're up to date");
  expect(isRecord(afterRace) ? afterRace.pageText : "").not.toContain("9.9.9");

  await step("The selected channel survives relaunch", async () => {
    const relaunched = await world.relaunch();
    const nextUser = user.on(relaunched);
    const nextProbe = probe.on(relaunched);
    await nextUser.see({ label: "Release channel" }, { timeoutMs: 60_000 });
    const state = await nextProbe.eventually(
      () => readSnapshot(nextProbe),
      { within: 30_000, label: "Alpha check after relaunch", until: (value) => isRecord(value) && Array.isArray(value.checks) && value.checks.includes("alpha") },
    );
    expect(isRecord(state) ? state.checks : []).toContain("alpha");
    expect(isRecord(state) ? state.checks : []).not.toContain("stable");
    expect(isRecord(state) ? state.nativeChannel : null).toBe("alpha");
    expect(isRecord(state) ? state.preferenceChannel : null).toBe("alpha");
    expect(isRecord(state) ? state.pickerText : "").toContain("Alpha");
  });
});
