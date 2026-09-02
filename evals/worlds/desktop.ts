import type { WorldSeed } from "./types.ts";

export async function emptySession(seed: WorldSeed) {
  const workspacePath = seed.tmpPath("empty-session");
  const app = await seed.desktop({ name: "empty-session" });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app);
  return { app, workspace, session, workspacePath };
}
