import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * A signed-in desktop whose organization has one or more desktop chat
 * features switched on before the app starts, with one chat on screen.
 * Desktop features follow the active organization's features (`GET /v1/org`),
 * so the switch is the same platform-admin capability route other worlds use.
 */
export async function featureDesktop(seed: Seed, name: string, capabilities: Record<string, true>, title: string) {
  const den = await seed.den({ org: { name: "Desktop features studio", admin: { name: "Workspace Owner" } } });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, capabilities);
  const app = await seed.desktop({ name, den, as: "admin" });
  const session = await seed.session(app, { title });
  const platform = await seed.evalIn(app, () => navigator.platform);
  const snapshot = () => seed.evalIn(app, browserScript((sessionId: string) => window.__OPENWORK_ELECTRON__.invokeDesktop("computerSnapshot", sessionId), [session.sessionId]), { awaitPromise: true });
  const setCapabilities = async (capabilities: Record<string, boolean>) => {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities }) });
    if (!result.response.ok) throw new Error(`Changing the desktop rollout failed: HTTP ${result.response.status}`);
  };
  return { den, organizationId, app, session, platform, snapshot, setCapabilities };
}

/** The floating browser presentation, with a page origin the built-in browser can always reach. */
export async function browserFloatingViewWorld(seed: Seed) {
  const world = await featureDesktop(seed, "browser-floating-view", { browserFloatingView: true }, "Comparing release notes");
  // The embedded OpenWork server answers any path, so the page is local and deterministic.
  const info = await seed.evalIn(world.app, () => window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo"), { awaitPromise: true });
  if (!info || typeof info !== "object" || !("baseUrl" in info) || typeof info.baseUrl !== "string" || !info.baseUrl) {
    throw new Error("The embedded OpenWork server is unavailable.");
  }
  const origin = info.baseUrl.replace(/\/+$/, "");
  const thumbnail = async (tabId: string) => {
    const value = await seed.evalIn(world.app, browserScript(async (id: string) => {
      const capture = window.__OPENWORK_ELECTRON__.browser?.thumbnail;
      return typeof capture === "function" ? capture(id) : null;
    }, [tabId]), { awaitPromise: true });
    if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string") return null;
    return { url: value.url };
  };
  return { ...world, origin, thumbnail, pageUrl: `${origin}/?floating-browser=release-notes` };
}

/** Computer use on this Mac. Readiness comes from the real helper and macOS permissions; nothing is faked. */
export async function computerUseWorld(seed: Seed) {
  return featureDesktop(seed, "computer-use-consent", { computerUse: true }, "Tidy the project folder");
}
