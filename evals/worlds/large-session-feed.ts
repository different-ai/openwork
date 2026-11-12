import type { Seed } from "@openwork/env";
import { calmFeed } from "./calm-feed.ts";

export async function largeSessionFeed(seed: Seed) {
  const world = await calmFeed(seed);
  const history = await seed.sessions(world.app, Array.from({ length: 250 }, (_, index) => `History task ${String(index + 1).padStart(3, "0")}`));
  return { ...world, history };
}
