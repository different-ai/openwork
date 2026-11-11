import {
  denOriginComparisonKey,
  markFeatureUsed,
  readDenSettings,
  resolveDenBaseUrls,
  resolveDenBaseUrlsForDestination,
} from "./den";
import { beginDenEnrollment, commitDenEnrollment } from "./den-handoff";
import { createDesktopDeviceLogin, DeviceLoginDiscoveryUnavailable, type DeviceLoginStartOptions } from "./device-login-flow";
import { desktopFetchViaMain } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";

/** Finite app-owned transport, also for packaged file:// renderers and alternate loopback ports. */
export function fetchDenDeviceLogin(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isDesktopRuntime() ? desktopFetchViaMain(input, { ...init, cancellable: true }, 10_000) : fetch(input, init);
}

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

// Credentials stay within the app's existing trusted renderer/main transport,
// never the shell command, engine, project plugins, or public control projection.
async function getJson(apiBaseUrl: string, path: string, signal: AbortSignal, token?: string): Promise<unknown> {
  const response = await fetchDenDeviceLogin(`${apiBaseUrl.replace(/\/+$/, "")}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "omit", redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok) throw new Error("Device sign-in request failed.");
  return response.json();
}

function discoveryPause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => { clearTimeout(timer); reject(new Error("Discovery cancelled.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Retry only this anonymous read: at most 4.95s, below prepare/control deadlines. */
export async function readDeviceLoginDeployment(apiBaseUrl: string, signal: AbortSignal): Promise<boolean> {
  assertDeviceLoginUrl(apiBaseUrl);
  const host = new URL(apiBaseUrl).host;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetchDenDeviceLogin(`${apiBaseUrl.replace(/\/+$/, "")}/v1/features`, {
        credentials: "omit", redirect: "error", cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
      });
    } catch {
      signal.throwIfAborted();
      // Network errors and per-attempt timeouts are safe to retry for this GET.
    }
    signal.throwIfAborted();
    if (response && response.status < 500) {
      if (!response.ok) throw new Error("Device discovery failed.");
      let payload: unknown;
      let readFailed = false;
      try { payload = await response.json(); }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof SyntaxError) throw new Error("Invalid device discovery response.");
        // The same per-attempt deadline covers a stalled or interrupted body.
        readFailed = true;
      }
      signal.throwIfAborted();
      if (!readFailed) {
        if (!record(payload) || !record(payload.features) || typeof payload.features.remoteDesktopDeviceLogin !== "boolean") {
          // Older/malformed Den fails closed, but is not an explicit deployment OFF.
          throw new Error("Invalid device discovery response.");
        }
        return payload.features.remoteDesktopDeviceLogin;
      }
    }
    if (attempt < 2) await discoveryPause(150 * (attempt + 1), signal);
  }
  throw new DeviceLoginDiscoveryUnavailable(host);
}

/** Renderer singleton: control actions receive only the public projection of this flow. */
export const denDeviceLogin = createDesktopDeviceLogin({
  fetcher: fetchDenDeviceLogin,
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
    // Always live and anonymous, even for the configured server or --force.
    if (!await readDeviceLoginDeployment(destination.apiBaseUrl, signal)) return null;
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
