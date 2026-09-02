import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { compatibleReleaseWorld } from "../worlds/first-run.ts";

const test = spec.world(compatibleReleaseWorld);
const currentArtifact = "https://releases.openwork.test/v2.4.0/OpenWork-darwin-arm64.dmg";
const previousArtifact = "https://releases.openwork.test/v2.3.1/OpenWork-darwin-arm64.dmg";

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
}

test("recovery offers only recent stable releases with exact compatible artifacts", async ({ world, user, seed, probe }) => {
  await user.click("Pick another version");
  await user.see({ text: /2\.4\.0\s+current/i });
  await user.see({ text: /Use 2\.3\.1\s+previous/i });
  await user.notSee({ text: /Use 2\.4\.0/i });
  await user.notSee({ text: /2\.3\.0|2\.2\.9|2\.2\.8-beta\.1/ });

  // TODO(primitive): inspect and negatively exercise the recovery catalog witness.
  const initial = await world.snapshot();
  const offered = typeof initial === "object" && initial !== null ? Reflect.get(initial, "releases") : null;
  expect(Array.isArray(offered) ? offered.map((release) => {
    const artifact = typeof release === "object" && release !== null ? Reflect.get(release, "artifact") : null;
    return {
      version: stringField(release, "version"),
      marking: stringField(release, "marking"),
      platform: stringField(artifact, "platform"),
      arch: stringField(artifact, "arch"),
      distribution: stringField(artifact, "distribution"),
      url: stringField(artifact, "url"),
    };
  }) : null).toEqual([
    { version: "2.4.0", marking: "current", platform: "darwin", arch: "arm64", distribution: "public", url: currentArtifact },
    { version: "2.3.1", marking: "previous", platform: "darwin", arch: "arm64", distribution: "public", url: previousArtifact },
  ]);
  await seed.evalIn(
    world.app,
    `Promise.all([window.__openworkRecoveryControl.select("2.3.0"), window.__openworkRecoveryControl.select("9.9.9")])`,
    { awaitPromise: true },
  );
  const afterInvalid = await world.snapshot();
  expect(typeof afterInvalid === "object" && afterInvalid !== null ? Reflect.get(afterInvalid, "openedArtifactUrls") : null).toEqual([]);

  await user.click("Use 2.3.1");
  const opened = await probe.eventually(
    async () => {
      const value = await world.snapshot();
      return typeof value === "object" && value !== null ? Reflect.get(value, "openedArtifactUrls") : null;
    },
    { within: 5_000, label: "exact compatible release artifact", until: (urls) => Array.isArray(urls) && urls.length === 1 },
  );
  expect(opened).toEqual([previousArtifact]);
  expect(opened).not.toContain(currentArtifact);
  expect(opened).not.toContain("https://incompatible.invalid/OpenWork.AppImage");
  expect(opened).not.toContain("https://wrong-flavor.invalid/OpenWork.dmg");
  expect(opened).not.toContain("https://prerelease.invalid/OpenWork.dmg");
});
