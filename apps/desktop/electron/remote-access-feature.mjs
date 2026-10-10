/** @typedef {{baseUrl: string, token: string, orgId: string}} FeatureSession */
/** @typedef {FeatureSession | {pending: true} | null} FeatureBinding */
/** @param {string} value */
function normalizeBase(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error("UNTRUSTED_FEATURE_ORIGIN");
  }
  return url.href.replace(/\/+$/, "");
}

/** The trusted main frame supplies its existing Den session, never a feature boolean.
 * Requests are restricted to deployment URLs captured at desktop startup. Upstream
 * credentials used by the phone bridge are entirely separate and remain in main.
 * @param {{baseUrls: string[], fetchImpl?: typeof fetch, now?: () => number,
 * localPolicy?: {enabled: boolean} | null}} options
 */
export function createRemoteAccessFeature({
  baseUrls,
  fetchImpl = fetch,
  now = Date.now,
  localPolicy = null,
}) {
  const trusted = new Set(baseUrls.map(normalizeBase));
  const defaultBase = trusted.values().next().value;
  if (!defaultBase) throw new Error("UNTRUSTED_FEATURE_ORIGIN");
  /** @type {FeatureSession | null} */
  let session = null;
  let revision = 0,
    cached = false,
    validUntil = 0,
    bound = false;
  return {
    /** @param {FeatureBinding} value */
    configure(value) {
      cached = false;
      validUntil = 0;
      revision++;
      session = null;
      bound = false;
      if (value === null) {
        bound = true;
        return;
      }
      if (!value || typeof value !== "object")
        throw new Error("INVALID_REQUEST");
      if ("pending" in value) {
        if (value.pending !== true) throw new Error("INVALID_REQUEST");
        return;
      }
      if (
        typeof value.baseUrl !== "string" ||
        typeof value.token !== "string" ||
        value.token.length > 16384 ||
        !value.token ||
        typeof value.orgId !== "string" ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(value.orgId)
      )
        throw new Error("INVALID_REQUEST");
      const baseUrl = normalizeBase(value.baseUrl);
      if (!trusted.has(baseUrl)) throw new Error("UNTRUSTED_FEATURE_ORIGIN");
      session = { baseUrl, token: value.token, orgId: value.orgId };
      bound = true;
    },
    async enabled() {
      // Supplied only by unpackaged local qualification via the registry resolver.
      // Packaged apps always consume the effective deployment/org decision below.
      if (localPolicy) return localPolicy.enabled;
      if (!bound) return false;
      if (now() < validUntil) return cached;
      const current = revision,
        context = session;
      try {
        const response = await fetchImpl(
          `${context?.baseUrl ?? defaultBase}${context ? "/v1/org" : "/v1/features"}`,
          {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: context
              ? {
                  Authorization: `Bearer ${context.token}`,
                  "x-openwork-org-id": context.orgId,
                }
              : {},
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("FEATURE_UNAVAILABLE");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("FEATURE_UNAVAILABLE");
        let bytes = 0,
          text = "";
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 256 * 1024) throw new Error("FEATURE_UNAVAILABLE");
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
        }
        const body = JSON.parse(text);
        if (current !== revision) return false;
        cached = body?.features?.remoteAccess === true;
      } catch {
        if (current !== revision) return false;
        cached = false;
      }
      validUntil = now() + 15000;
      return cached;
    },
  };
}
