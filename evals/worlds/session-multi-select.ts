import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * A member signed in to the app in a browser with four real sessions and
 * sidebar multi-select still off for their organization. No model is called.
 */
export async function sessionMultiSelectWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Sidebar cleanup workspace", admin: { name: "Workspace owner" } },
  });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, name: "session-multi-select", workspacePath: seed.tmpPath("session-multi-select"), engine: "v2", headless: true,
  });
  // Created oldest first; the last one is open, so the list reads top to bottom: open, then three to clean up.
  const sessions = [];
  for (const title of ["Draft the launch email", "Compare vendor quotes", "Summarize the board notes", "Plan the team offsite"]) {
    sessions.push(await seed.session(app, { title }));
  }
  return {
    app, workspace, sessions,
    /** A platform admin turns sidebar multi-select on for the organization. */
    turnOnMultiSelect: () => enableOrganizationCapabilities(seed, den.admin, { sessionMultiSelect: true }),
  };
}
