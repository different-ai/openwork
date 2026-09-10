import type { Seed } from "@openwork/env";

export async function emptySession(seed: Seed) {
  const workspacePath = seed.tmpPath("empty-session");
  const app = await seed.desktop({ name: "empty-session" });
  // Create the workspace at the declared tmp path. Without `create`, the seed
  // adopts the first-launch default workspace, which the dev profile places
  // inside the repo checkout on Daytona; the engine then merges the repo's
  // `.opencode/opencode.json` (`"permission": "allow"`) over the workspace's
  // own permission block, so workspace-level permission claims never hold.
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  const session = await seed.session(app);
  return { app, workspace, session, workspacePath };
}
