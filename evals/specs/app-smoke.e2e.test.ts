import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appSmokeWorld } from "../worlds/first-run.ts";

const test = spec.world(appSmokeWorld);

test("app boots with a control route and meaningful visible content", async ({ world, user, probe }) => {
  expect(world.workspace.workspaceId).toBeTruthy();
  expect(await probe.hash()).toBeTruthy();
  expect((await probe.text()).trim().length).toBeGreaterThan(40);
  await user.looks([
    "A ready OpenWork workspace composer with meaningful visible content is on screen",
    "No generic error or 'Something went wrong' crash message is visible",
  ]);
});
