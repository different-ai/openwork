import { startBrowserFixture } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { featureDesktop } from "./desktop-chat-features.ts";

export async function computerShortcutsWorld(seed: Seed) {
  const world = await featureDesktop(seed, "computer-shortcuts", { computerUse: true }, "Prepare the weekly project report");
  const neighbor = await seed.session(world.app, { title: "Another project" });
  const fixture = await startBrowserFixture(world.app, { requireSignIn: false });
  return { ...world, neighbor, origin: fixture.origin, async [Symbol.asyncDispose]() { await fixture[Symbol.asyncDispose](); } };
}
