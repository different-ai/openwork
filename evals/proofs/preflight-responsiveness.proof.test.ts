import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { preflightResponsiveness } from "../worlds/preflight-responsiveness.ts";

const test = spec.world(preflightResponsiveness, {
  timeout: 300_000,
  needs: { commands: ["pnpm"], placement: "local" },
  resources: { surfaces: [], services: [], nativeReason: "The production resumed-copy preflight must run on an isolated Electron main loop." },
});

test("a resumed history copy refuses insufficient space without starving Electron main", async ({ world, evidence }) => {
  const result = world.result;
  evidence.recordAssertionEvidence("Disk refusal stays exact without changing source, checkpoint or creating a target", result.raw, result.safe && result.exactRefusal);
  expect(result.safe).toBe(true);
  expect(result.exactRefusal).toBe(true);
  evidence.recordAssertionEvidence("Real Electron main heartbeat stays below 250 ms during restoring-stage aggregate SQL", result.raw, result.electronMain && result.maxLag < 250 && result.stalls === 0);
  expect(result.electronMain).toBe(true);
  expect(result.maxLag, "Electron main preflight lag").toBeLessThan(250);
  expect(result.stalls).toBe(0);
  evidence.recordAssertionEvidence("Shutdown joins the active estimation worker before disk checks or copy can start", result.raw, result.cancelled);
  expect(result.cancelled).toBe(true);
});
