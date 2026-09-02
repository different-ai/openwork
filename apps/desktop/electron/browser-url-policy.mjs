// Organization browser URL allowlist for the built-in browser.
//
// The renderer forwards the effective desktop policy's `allowedBrowserHosts`
// (already normalized by @openwork/types) and the main process enforces it on
// every http(s) frame load in the browser session, so agent-driven CDP
// navigations, address-bar loads, redirects, and popups all meet the same
// rule. Non-http(s) URLs (about:blank, data: marker pages, openwork:// deep
// links, chrome-error:) are internal plumbing and stay allowed.

const ANY_HOST = "*";
const BLOCKED_PAGE_TITLE = "Blocked by your organization";

function normalizeHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return host && !/\s/.test(host) ? host : null;
}

/**
 * @param {unknown} hosts host patterns from the effective desktop policy
 * @returns {{ hosts: string[] } | null} compiled policy, or null when every website is allowed
 */
export function compileBrowserUrlPolicy(hosts) {
  if (!Array.isArray(hosts)) return null;
  const normalized = [...new Set(hosts.map(normalizeHost).filter((host) => host !== null))];
  if (normalized.length === 0 || normalized.includes(ANY_HOST)) return null;
  return { hosts: normalized };
}

export function isBrowserUrlSubjectToPolicy(url) {
  return /^https?:\/\//i.test(String(url ?? ""));
}

/**
 * @param {string} url
 * @param {{ hosts: string[] } | null} policy
 */
export function isBrowserUrlAllowed(url, policy) {
  if (!policy) return true;
  if (!isBrowserUrlSubjectToPolicy(url)) return true;
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (!hostname) return false;
  return policy.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

export function blockedBrowserHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url ?? "");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function blockedBrowserPageUrl(url) {
  const host = escapeHtml(blockedBrowserHost(url));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${BLOCKED_PAGE_TITLE}</title>` +
    `<meta name="openwork-browser-blocked" content="${host}">` +
    `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2937;background:#f9fafb}` +
    `main{max-width:420px;padding:32px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{margin:0 0 8px;color:#4b5563}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#111827}</style></head>` +
    `<body><main><h1>${BLOCKED_PAGE_TITLE}</h1><p><code>${host}</code> is not on your organization's list of approved websites.</p>` +
    `<p>Ask your administrator to allow it in the desktop policy.</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function blockedBrowserUrlMessage(url) {
  return `${BLOCKED_PAGE_TITLE}: ${blockedBrowserHost(url)} is not on the approved website list.`;
}

export function isBlockedBrowserPageUrl(url) {
  return typeof url === "string" && url.startsWith("data:text/html") && url.includes("openwork-browser-blocked");
}
