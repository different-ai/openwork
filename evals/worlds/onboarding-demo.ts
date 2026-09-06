import type { Seed } from "@openwork/env";
import { signupWorkspace } from "./signup-workspace.ts";

export async function onboardingDemo(seed: Seed) {
  const world = await signupWorkspace(seed);
  world.owner.name = "Alex";
  world.owner.email = "alex@openwork.test";
  world.owner.password = "OpenWork-demo-9274!";
  await world.web.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 940, deviceScaleFactor: 1, mobile: false,
  });
  return world;
}
