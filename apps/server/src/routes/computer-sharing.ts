import { computerSharing } from "../computers/sharing.js";
import { ComputerSharingSettingsError } from "../computers/sharing-settings.js";
import { runnerCredentialSchema } from "../computers/runner-credential.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { addRoute, type Route } from "./registry.js";

async function body(request: Request): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new ApiError(400, "invalid_json", "The request isn't valid."); }
}
const privateJson = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });
export function registerComputerSharingRoutes(routes: Route[], config: ServerConfig, sharing = computerSharing(config)) {
  addRoute(routes, "GET", "/computers/sharing", "host", async () => privateJson(await sharing.state()));
  addRoute(routes, "GET", "/computers/sharing/availability", "host", async () => privateJson({ availability: await sharing.availability() }));
  addRoute(routes, "PUT", "/computers/sharing", "host", async ({ request }) => {
    try { return privateJson(await sharing.updateSettings(await body(request))); }
    catch (error) {
      if (error instanceof ComputerSharingSettingsError) throw new ApiError(400, "invalid_sharing_settings", error.message);
      throw error;
    }
  });
  addRoute(routes, "PUT", "/computers/runner", "host", async ({ request }) => {
    const credential = runnerCredentialSchema.safeParse(await body(request));
    if (!credential.success) throw new ApiError(400, "invalid_runner_credential", "OpenWork couldn't use this organization's computer connection.");
    sharing.updateCredential(credential.data);
    return privateJson({ ok: true });
  });
  addRoute(routes, "DELETE", "/computers/runner", "host", async () => {
    sharing.updateCredential(null);
    return privateJson({ ok: true });
  });
}
