import type { Seed } from "@openwork/env";
import { calmFeed } from "./calm-feed.ts";

/** Reuse the signed-in Feed fixture's real Den capability arrangement. No
 * renderer writes, extra rollout switch, or model turn is needed for actions. */
export async function sharedSessionUiActionsFeed(seed: Seed) {
  const world = await calmFeed(seed);
  const untouched = await seed.session(world.app, { title: "Keep these reference notes" });
  return {
    app: world.app,
    workspace: world.workspace,
    main: world.resting,
    side: world.question,
    untouched,
  };
}
