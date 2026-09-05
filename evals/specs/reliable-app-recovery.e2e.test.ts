import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { reliableRecoveryWorld } from "../worlds/first-run.ts";

const test = spec.world(reliableRecoveryWorld, { timeout: 300_000 });
const verifiedArtifact = "https://releases.openwork.test/v1.8.2/OpenWork-darwin-arm64.dmg";

test("a fatal desktop bootstrap failure offers one-click verified recovery without losing the profile", async ({ world, user, seed, probe }) => {
  await user.see({ text: /OpenWork (couldn't|could not) start/i });
  await user.see("Restore previous version");
  await user.notSee({ text: /EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE|invalid code signature/ });
  await user.notSee({ text: /GitHub|open an issue|download.*manually/i });

  // TODO(primitive): inspect the fatal-bootstrap recovery witness and profile bootstrap.
  expect(await world.workspaceNames()).toContain("reliable-recovery-profile-marker");
  const initial = await world.snapshot();
  const candidates = typeof initial === "object" && initial !== null ? Reflect.get(initial, "candidates") : [];
  expect(Array.isArray(candidates) ? candidates.map((entry) => typeof entry === "object" && entry !== null ? Reflect.get(entry, "version") : null) : [])
    .toEqual(["1.8.2"]);

  // TODO(primitive): negatively exercise an unverified recovery candidate.
  await seed.evalIn(world.app, `window.__openworkRecoveryControl.select("1.8.1")`, { awaitPromise: true });
  const afterInvalid = await world.snapshot();
  expect(typeof afterInvalid === "object" && afterInvalid !== null ? Reflect.get(afterInvalid, "installRequests") : null).toEqual([]);
  expect(typeof afterInvalid === "object" && afterInvalid !== null ? Reflect.get(afterInvalid, "quitRequested") : null).toBe(false);

  await user.click("Restore previous version");
  const requests = await probe.eventually(
    async () => {
      const value = await world.snapshot();
      return typeof value === "object" && value !== null ? Reflect.get(value, "installRequests") : null;
    },
    { within: 5_000, label: "verified previous recovery install intent", until: (value) => Array.isArray(value) && value.length === 1 },
  );
  expect(requests).toEqual([{ version: "1.8.2", artifactUrl: verifiedArtifact }]);
  const final = await world.snapshot();
  expect(typeof final === "object" && final !== null ? Reflect.get(final, "quitRequested") : null).toBe(false);
});
