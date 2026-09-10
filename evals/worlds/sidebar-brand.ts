import { createAndSelectWorkspace } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import type { Place } from "@openwork/testkit";

export async function sidebarBrandApp(place: Place) {
  const app = await desktop({ name: "sidebar-brand-geometry", host: place.host() });
  try {
    if (!app.workspaceRoot) throw new Error("Expected an isolated spawned app");
    await createAndSelectWorkspace(app, { path: `${app.workspaceRoot}/evals-tmp/sidebar-brand-${Date.now()}` });
    return app;
  } catch (error) {
    await app.stop();
    throw error;
  }
}
