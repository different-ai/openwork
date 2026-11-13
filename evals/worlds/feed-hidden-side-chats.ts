import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/** Fresh signed-in v2 history, with an idle side-chat candidate between two tasks. */
export async function feedHiddenSideChats(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed);
  const requested = seed.tmpPath("feed-hidden-side-chats");
  const workspacePath = join(realpathSync(dirname(requested)), basename(requested));
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine: "v2", name: "feed-hidden-side-chats", workspacePath,
    headless: true,
  });

  // Seed has no storage writer. Native creation/rename times arrange newest-first
  // order without localStorage, renderer setters, or a hand-built session cache.
  // Separate even second-resolution engine timestamps; opening a task does not
  // count as new work. No prompt is sent and no inference provider is needed.
  const below = await seed.session(app, { title: "Reference checklist" });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const side = await seed.session(app, { title: "Supporting discussion" });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const above = await seed.session(app, { title: "Project outline" });
  return { app, workspace, above, side, below };
}
