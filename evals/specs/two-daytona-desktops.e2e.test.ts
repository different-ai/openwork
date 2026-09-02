import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { twoDaytonaDesktopsWorld } from "../worlds/infra.ts";

const test = spec.world(twoDaytonaDesktopsWorld, {
  needs: { placement: "daytona" },
  timeout: 300_000,
});

test("two desktops reach interactive workspaces on different Daytona sandboxes", async ({ world }) => {
  expect(world.sandboxA).not.toBe(world.sandboxB);
  expect(world.appA.handle.sandboxId).toBe(world.sandboxA);
  expect(world.appB.handle.sandboxId).toBe(world.sandboxB);
  expect(world.workspaceA.workspaceId).toBeTruthy();
  expect(world.workspaceB.workspaceId).toBeTruthy();
});
