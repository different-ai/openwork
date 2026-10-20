import type { Seed } from "@openwork/env";

/** The desktop-only host discovery and restart control need the native bridge.
 * Run in a sandbox, never as a focus-stealing local Electron window. */
export async function engineUpgradePaused(seed: Seed) {
  const app = await seed.desktop({
    name: "engine-upgrade-paused",
    ownSandbox: true,
    env: {
      OPENWORK_ENGINE_V2_PREVIEW: "",
      OPENWORK_ENGINE_FORCE_POLICY: "1",
      OPENWORK_ENGINE_AUTO_UPGRADE: "1",
      OPENWORK_OPENCODE2_BIN: "/unavailable-fixture-engine/opencode2",
    },
  });
  const workspace = await seed.workspace(app, `${seed.tmpPath("project-notes")}/Project notes`);
  const session = await seed.session(app, { title: "Work continues while the upgrade is paused" });
  return { app, workspace, session };
}
