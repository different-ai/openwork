import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { engineLiveDesktop } from "../worlds/engine-live-desktop.ts";

const test = spec.world(engineLiveDesktop, { timeout: 180_000,
  resources: { surfaces: ["desktop"], services: [], nativeReason: "Measure production startup behavior in a fresh native development app profile." },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test(`LIVE-LAUNCH ${resolveEvalEngine()}: a fresh native app opens an editable conversation with a model`, async ({ world, user, probe, evidence }) => {
  const arrived = performance.now();
  await user.see("composer", { editable: true, timeoutMs: 90_000 });
  await probe.eventually(() => probe.composer(), { within: 90_000, label: "model ready", until: state => !state.modelUnavailable });
  expect(await probe.storage("openwork.den.authToken")).toBeNull();
  evidence.recordJsonArtifact("Native launch timings", {
    engine: world.engine, interactiveMs: world.interactiveMs,
    composerReadyMs: world.interactiveMs + performance.now() - arrived,
    boundary: "Before seed.desktop launch to native bridge ready / visible editable composer with a selectable model. Includes development build and harness overhead; shared build caches, fresh app profile. Does not imply inference succeeds.",
  });
  await user.screenshot();
});
