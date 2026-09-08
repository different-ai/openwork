export const INSTALLATION_ACCESS_FILENAME = "installation-access.v1.json";

/** Historical cohort records no longer impose public-desktop sign-in policy. */
export function installationRequiresSignin(_raw) {
  return false;
}

/** Kept inert for existing callers: no reading, deleting, or rewriting durable state. */
export function initializeInstallationAccess(_options) {
  return false;
}

function denHttpUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid Den URL");
  }
  return url;
}

function bootstrapApiKey(config) {
  return JSON.stringify([config.baseUrl, config.apiBaseUrl ?? null]);
}

export const DESKTOP_DEN_API_CACHE_MS = 60_000;

/** Only the configured web origin may publish a runtime API destination. */
export function createDesktopDenApiResolver({ fetcher, now = Date.now }) {
  let cached = null;
  return (config) => {
    const key = bootstrapApiKey(config);
    if (cached?.key === key && now() < cached.expiresAt) return cached.promise;
    const promise = (async () => {
      const web = denHttpUrl(config.baseUrl);
      const response = await fetcher(new URL("/api/runtime-config", web).href, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(2_000),
      });
      // A deployment without this endpoint may use its explicit API or the
      // ordinary deterministic default. A failed refresh must not revive an
      // obsolete API from bootstrap or a previous cache entry.
      if (!response.ok && response.status !== 404) throw new Error("Den runtime configuration unavailable");
      const payload = response.ok ? await response.json() : null;
      const published = payload?.denApiUrl;
      if (published != null && typeof published !== "string") throw new Error("Invalid Den runtime API URL");
      if (published?.trim()) {
        const api = denHttpUrl(published.trim());
        if (web.protocol === "https:" && api.protocol !== "https:") throw new Error("Insecure Den runtime API URL");
        return api.href.replace(/\/+$/, "");
      }
      if (config.apiBaseUrl?.trim()) return denHttpUrl(config.apiBaseUrl.trim()).href.replace(/\/+$/, "");

      // Same defaults as the renderer's resolveDenBaseUrls; a runtime-published
      // endpoint above is authoritative, including for split-origin deployments.
      const explicitApiHost = web.hostname === "api" || web.hostname.startsWith("api.");
      if (explicitApiHost || web.hostname === "openworklabs.com" || web.hostname.endsWith(".openworklabs.com")) {
        if (!explicitApiHost) web.hostname = `api.${web.hostname}`;
        return web.origin;
      }
      web.pathname = `${web.pathname.replace(/\/+$/, "").replace(/\/api\/den$/i, "")}/api/den`;
      return web.href.replace(/\/+$/, "");
    })();
    cached = { key, expiresAt: now() + DESKTOP_DEN_API_CACHE_MS, promise };
    void promise.catch(() => { if (cached?.promise === promise) cached = null; });
    return promise;
  };
}

/** Main-process session custody. Retained tokens are not proof of a valid session. */
export function createInstallationSession({ readBootstrapConfig, fetcher, now = Date.now }) {
  const resolveApiBaseUrl = createDesktopDenApiResolver({ fetcher, now });
  let credential = null;
  let generation = 0;
  let pending = null;

  /** @returns {Promise<import("@openwork/types/desktop-ipc").InstallationSessionResult>} */
  async function verify() {
    if (!credential) return { status: "signed_out" };
    const config = readBootstrapConfig();
    if (credential.baseUrl !== config.baseUrl) return { status: "signed_out" };
    const key = bootstrapApiKey(config);
    const current = generation;
    if (pending?.generation === current && pending.key === key) return pending.promise;
    const { token } = credential;
    const isCurrent = () => current === generation && key === bootstrapApiKey(readBootstrapConfig());
    const promise = (/** @returns {Promise<import("@openwork/types/desktop-ipc").InstallationSessionResult>} */ async () => {
      /** @type {Extract<import("@openwork/types/desktop-ipc").InstallationSessionResult, { status: "unavailable" }>["reason"]} */
      let reason = "runtime_config_unavailable";
      try {
        const baseUrl = await resolveApiBaseUrl(config);
        if (!isCurrent()) return { status: "signed_out" };
        reason = "session_request_failed";
        const response = await fetcher(`${baseUrl}/v1/me`, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        const payload = await response.json().catch(() => null);
        if (!isCurrent()) return { status: "signed_out" };
        if (response.status === 401) {
          if (["unauthorized", "invalid_session", "session_expired", "session_revoked", "session_not_found", "invalid_token", "token_expired", "token_revoked"].includes(payload?.error)) {
            return { status: "signed_out" };
          }
        }
        if (!response.ok) return { status: "unavailable", reason: "session_http_error" };
        if (typeof payload?.user?.id !== "string" || !payload.user.id.trim() || typeof payload.user.email !== "string") return { status: "unavailable", reason: "session_payload_invalid" };
        return { status: "signed_in", user: {
          id: payload.user.id, email: payload.user.email,
          name: typeof payload.user.name === "string" ? payload.user.name : null,
        } };
      } catch {
        return isCurrent() ? { status: "unavailable", reason } : { status: "signed_out" };
      }
    })();
    pending = { generation: current, key, promise };
    try { return await promise; }
    finally { if (pending?.promise === promise) pending = null; }
  }

  return {
    verify,
    async setToken(token, sourceBaseUrl = undefined) {
      const normalized = typeof token === "string" ? token.trim() : "";
      if (!normalized) {
        generation++;
        credential = null;
        return verify();
      }
      const { baseUrl } = readBootstrapConfig();
      // The renderer supplies the token's source, never its API destination.
      // Reject stale handoffs after a main-owned control-plane switch.
      if (!sourceBaseUrl || denHttpUrl(sourceBaseUrl).origin !== denHttpUrl(baseUrl).origin) {
        generation++;
        credential = null;
        return verify();
      }
      if (credential?.token !== normalized || credential?.baseUrl !== baseUrl) {
        generation++;
        credential = { token: normalized, baseUrl };
      }
      return verify();
    },
  };
}
