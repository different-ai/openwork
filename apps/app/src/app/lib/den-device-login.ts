import {
  denOriginComparisonKey,
  markFeatureUsed,
  readDenSettings,
  resolveDenBaseUrls,
  resolveDenBaseUrlsForDestination,
} from "./den";
import { beginDenEnrollment, commitDenEnrollment } from "./den-handoff";
import { createDesktopDeviceLogin, type DeviceLoginStartOptions } from "./device-login-flow";

export function isConfiguredDenDeviceDestination(options: DeviceLoginStartOptions): boolean {
  const stored = readDenSettings();
  const baseUrl = options.baseUrl?.trim() || stored.baseUrl;
  if (denOriginComparisonKey(baseUrl) !== denOriginComparisonKey(stored.baseUrl)) return false;
  const target = resolveDenBaseUrls({ baseUrl, apiBaseUrl: options.apiBaseUrl ?? stored.apiBaseUrl });
  const configured = resolveDenBaseUrls(stored);
  return target.apiBaseUrl === configured.apiBaseUrl;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDeviceLoginUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (
    url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )) throw new Error("Invalid device sign-in destination.");
}

// Deliberately renderer fetch: desktopFetch serializes credentials through __fetch IPC.
// Cross-origin deployments must permit these bearer-only requests via CORS; do not
// silently fall back to the main-process transport when a server rejects preflight.
async function getJson(apiBaseUrl: string, path: string, signal: AbortSignal, token?: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "omit", redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok) throw new Error("Device sign-in request failed.");
  return response.json();
}

/** Renderer singleton: control actions receive only the public projection of this flow. */
export const denDeviceLogin = createDesktopDeviceLogin({
  isSignedIn: () => Boolean(readDenSettings().authToken?.trim()),
  beginEnrollment: () => beginDenEnrollment({ deferred: true }),
  async prepare(options, signal) {
    const stored = readDenSettings();
    const baseUrl = options.baseUrl?.trim() || stored.baseUrl;
    assertDeviceLoginUrl(baseUrl);
    if (options.apiBaseUrl) assertDeviceLoginUrl(options.apiBaseUrl);
    const sameOrigin = denOriginComparisonKey(stored.baseUrl) === denOriginComparisonKey(baseUrl);
    const destination = await resolveDenBaseUrlsForDestination({
      baseUrl,
      apiBaseUrl: options.apiBaseUrl ?? (sameOrigin ? stored.apiBaseUrl : undefined),
    });
    assertDeviceLoginUrl(destination.baseUrl);
    assertDeviceLoginUrl(destination.apiBaseUrl);
    // Always deployment-scoped, even when --force replaces an authenticated session.
    // A missing flag (older Den) or an unavailable discovery endpoint fails closed.
    let payload: unknown;
    try { payload = await getJson(destination.apiBaseUrl, "/v1/features", signal); }
    catch { return null; }
    if (!record(payload) || !record(payload.features) || payload.features.remoteDesktopDeviceLogin !== true) return null;
    return destination;
  },
  async enroll({ token, destination, attempt, signal }) {
    const payload = await getJson(destination.apiBaseUrl, "/v1/me", signal, token);
    if (!record(payload) || !record(payload.user) || !record(payload.session)) throw new Error("Invalid device session.");
    const user = payload.user;
    const approvedOrgId = payload.session.activeOrganizationId;
    if (typeof user.id !== "string" || !user.id || typeof user.email !== "string" || !user.email || typeof approvedOrgId !== "string" || !approvedOrgId) throw new Error("Invalid device identity.");
    const organizations = await getJson(destination.apiBaseUrl, "/v1/me/orgs", signal, token);
    // /me/orgs can resolve a default org. It is not evidence of browser approval:
    // require the exact active org already carried by the newly issued session.
    if (!record(organizations) || organizations.activeOrgId !== approvedOrgId || !Array.isArray(organizations.orgs)) throw new Error("Device organization changed.");
    const org: unknown = organizations.orgs.find((entry: unknown) => record(entry) && entry.id === approvedOrgId);
    if (!record(org) || typeof org.name !== "string" || !org.name) throw new Error("Approved organization is unavailable.");
    if (signal.aborted || !attempt.isCurrent()) throw new Error("Device sign-in superseded.");
    const organization = { id: approvedOrgId, name: org.name, slug: typeof org.slug === "string" ? org.slug : null };
    // Expiry can arrive during an asynchronous bootstrap write, not only fetch.
    // Feed it into the same transaction guard used by explicit cancellation.
    const cancelEnrollment = () => attempt.cancel();
    signal.addEventListener("abort", cancelEnrollment, { once: true });
    if (signal.aborted) cancelEnrollment();
    try {
      const committed = await commitDenEnrollment({
        attempt, destination, storedSettings: readDenSettings(),
        exchange: {
          token,
          user: { id: user.id, email: user.email, name: typeof user.name === "string" ? user.name : null },
          organization, connectEnabled: null,
        },
        options: { ...destination, activeOrg: organization, desktopInitiated: false },
        safeErrors: true,
      });
      if (!committed.ok) throw new Error("Device enrollment failed.");
      // Existing batched usage reporting only; never make a committed sign-in fail.
      try { markFeatureUsed("remoteDesktopDeviceLogin"); } catch {}
      return { email: user.email, org: { id: organization.id, name: organization.name } };
    } finally {
      signal.removeEventListener("abort", cancelEnrollment);
    }
  },
});
