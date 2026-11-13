import type { Seed } from "@openwork/env";

/** Fresh local-first v2 history; no account, Den server, or model calls. */
export async function feedHiddenSideChats(seed: Seed) {
  const app = await seed.appWeb({
    workspacePath: seed.tmpPath("feed-hidden-side-chats"),
    engine: "v2", name: "feed-hidden-side-chats", headless: true, mouse: true,
  });
  const workspace = await seed.workspace(app, app.workspaceRoot);

  // Native creation times arrange newest-first order without renderer setters.
  const below = await seed.session(app, { title: "Reference checklist" });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const side = await seed.session(app, { title: "Supporting discussion" });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const above = await seed.session(app, { title: "Project outline" });
  return { app, workspace, above, side, below };
}
