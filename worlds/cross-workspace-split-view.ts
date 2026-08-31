import { seedSessions } from "../evals/packages/behaviors/src/sessions.ts";
import { app } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { createAdmin, createOrg, server } from "../evals/packages/env/src/den.ts";
import type { Den, DenOrgHandle } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";

export const CROSS_WORKSPACE_SPLIT_VIEW_ORG = "Cross Workspace Split View";

export interface CrossWorkspaceSplitViewOptions {
  adminEmail: string;
  workspacePath: string;
  sessionTitles: readonly string[];
}

export interface CrossWorkspaceSplitViewWorld {
  den: Den;
  admin: Awaited<ReturnType<typeof createAdmin>>;
  org: DenOrgHandle;
  desktop: App;
  sessions: { sessionId: string; title: string }[];
}

/**
 * Repro world for validating split view across two sessions that belong to
 * different local workspaces. The builder seeds the signed-in desktop and the
 * first workspace; the scenario creates a second workspace at runtime so each
 * run gets isolated temporary workspace paths.
 */
export async function bootCrossWorkspaceSplitView(
  stack: AsyncDisposableStack,
  place: Place,
  options: CrossWorkspaceSplitViewOptions,
): Promise<CrossWorkspaceSplitViewWorld> {
  const den = stack.use(await server({ place, provision: false, web: true }));
  const admin = await createAdmin(den, {
    name: "Split View Admin",
    email: options.adminEmail,
  });
  const org = stack.use(await createOrg(den, CROSS_WORKSPACE_SPLIT_VIEW_ORG));
  const desktop = stack.use(await app({
    den,
    place,
    as: "admin",
    workspacePath: options.workspacePath,
  }));
  const sessions = await seedSessions(desktop, options.sessionTitles);
  return { den, admin, org, desktop, sessions };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const { den, desktop } = await bootCrossWorkspaceSplitView(stack, resolvePlace(), {
    adminEmail: "split-view-admin@openwork.test",
    workspacePath: "/tmp/openwork-cross-workspace-split-primary",
    sessionTitles: ["Primary split anchor", "Primary same-workspace peer"],
  });
  await hold({
    outputs: {
      denWeb: den.ref.webUrl,
      denApi: den.ref.apiUrl,
      cdp: desktop.handle.cdpUrl,
    },
  });
}

if (import.meta.main) await main();
