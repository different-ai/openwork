import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSmokeWorld } from "../worlds/first-run.ts";

const test = spec.world(appSmokeWorld);

test("app boots with a control route and meaningful visible content", async ({ world, user, probe, evidence }) => {
  expect(await probe.hash()).toBeTruthy();
  expect((await probe.text()).trim().length).toBeGreaterThan(40);
  if (world.packaged) {
    expect(await world.packagedRuntime()).toEqual({
      bridge: true, protocol: "file:", health: 200, welcome: true, crash: false,
    });
    evidence.recordAssertionEvidence(
      "The packaged desktop loads its renderer, preload bridge, and embedded server without a development server",
      "The installed-layout binary reached an interactive welcome screen through file: assets; a preload IPC round trip returned its embedded server endpoint and HTTP health returned 200. No crash screen was present. The host used a fresh isolated profile.",
      true,
    );
  } else {
    expect(world.workspace?.workspaceId).toBeTruthy();
    await user.looks([
    "A ready OpenWork workspace composer with meaningful visible content is on screen",
    "No generic error or 'Something went wrong' crash message is visible",
    ]);
  }
});
