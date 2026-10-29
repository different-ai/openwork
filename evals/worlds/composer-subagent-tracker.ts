import { mkdir, realpath } from "node:fs/promises";
import { browserScript } from "@openwork/cdp";
import { eventually, type Seed } from "@openwork/env";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * A signed-in member on OpenCode v2 with one conversation open. The
 * composer's Agents list (`composerSubagentTracker`) starts off for the
 * organization so a spec can show the before state; `setTracker` flips it
 * through the same platform-admin route /admin uses.
 */
export async function composerSubagentTrackerWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Billing team", admin: { name: "Billing Owner" } } });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The seeded organization is unavailable.");
  const directory = seed.tmpPath("composer-subagent-tracker");
  await mkdir(directory, { recursive: true });
  const workspacePath = await realpath(directory);
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, workspacePath, name: "composer-subagent-tracker", engine: "v2", headless: true,
  });
  // A cold CI runner installs the v2 engine archive first (up to 180 s). The
  // control rail keeps session.create_task disabled until then, and
  // seed.session() only waits 60 s, so settle the engine before creating it.
  await eventually(() => seed.evalIn(app, browserScript(async () => {
    const base = `http://127.0.0.1:${localStorage.getItem("openwork.server.port")}`;
    const headers = { Authorization: `Bearer ${localStorage.getItem("openwork.server.token")}` };
    try {
      const response = await fetch(`${base}/experimental/engine-v2-preview/status`, { headers });
      if (!response.ok) return false;
      const status: unknown = await response.json();
      return typeof status === "object" && status !== null && Reflect.get(status, "running") === true && Reflect.get(status, "chatRouting") === true;
    } catch {
      return false;
    }
  }, []), { awaitPromise: true, timeoutMs: 15_000 }), {
    within: 210_000, intervalMs: 1_000, label: "the v2 engine is running", until: (running) => running,
  });
  const session = await seed.session(app, { title: "Billing release" });
  const setTracker = async (enabled: boolean) => {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT", body: JSON.stringify({ capabilities: { composerSubagentTracker: enabled } }),
    });
    if (!result.response.ok) throw new Error(`Switching the Agents list failed: HTTP ${result.response.status}`);
  };
  await setTracker(false);
  return { app, den, workspace, session, setTracker };
}
