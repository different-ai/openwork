// Keep this mapping deliberately small. A native item is offered only when an
// HTTPS URL has a documented, unambiguous equivalent in an installed app.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]|%(?:0[0-9a-f]|1[0-9a-f]|7f)|%c2%[89][0-9a-f]/i;
const ENCODED_UNSAFE_PATH_CHARACTER = /%(?:2e|2f|5c)/i;
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;
const DOT_PATH_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/;
const DUPLICATE_PATH_SEPARATOR = /\/\//;
const NOTION_PAGE_ID = /(?:^|-)(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const LINEAR_ISSUE_ID = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const SLACK_TEAM_ID = /^T[A-Z0-9]{5,}$/;
const SLACK_CHANNEL_ID = /^C[A-Z0-9]{5,}$/;

/** @typedef {{ protocol: "notion:" | "linear:" | "slack:", url: string }} NativeAppLink */
/** @typedef {NativeAppLink & { name: string }} RegisteredNativeAppLink */

/**
 * Parse an exact HTTPS origin without accepting credentials, explicit ports,
 * backslash normalization, lookalike hosts, or encoded path separators.
 * @param {string} rawUrl
 * @param {Set<string>} allowedHosts
 * @returns {URL | null}
 */
function canonicalHttpsUrl(rawUrl, allowedHosts) {
  if (typeof rawUrl !== "string" || !rawUrl || rawUrl !== rawUrl.trim()
    || rawUrl.includes("\\") || CONTROL_CHARACTERS.test(rawUrl)) return null;
  const authority = rawUrl.match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/i)?.[1];
  if (!authority || authority.includes(":")) return null;
  const rawPath = rawUrl.slice(rawUrl.indexOf(authority) + authority.length).split(/[?#]/, 1)[0];
  if (ENCODED_UNSAFE_PATH_CHARACTER.test(rawPath) || INVALID_PERCENT_ESCAPE.test(rawPath)
    || DOT_PATH_SEGMENT.test(rawPath) || DUPLICATE_PATH_SEPARATOR.test(rawPath)) return null;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
    || authority.toLowerCase() !== parsed.hostname || !allowedHosts.has(parsed.hostname)) return null;
  return parsed;
}

/** @param {URL} parsed @returns {NativeAppLink | null} */
function notionLink(parsed) {
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 2 || segments.some(segment => segment === "." || segment === "..")
    || !NOTION_PAGE_ID.test(segments.at(-1))) return null;
  return { protocol: "notion:", url: `notion://www.notion.so${parsed.pathname}${parsed.search}${parsed.hash}` };
}

/** @param {URL} parsed @returns {NativeAppLink | null} */
function linearLink(parsed) {
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "issue" || !LINEAR_ISSUE_ID.test(segments[1])
    || parsed.search || parsed.hash) return null;
  return { protocol: "linear:", url: `linear://linear.app${parsed.pathname}` };
}

/** @param {URL} parsed @returns {NativeAppLink | null} */
function slackLink(parsed) {
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "client" || !SLACK_TEAM_ID.test(segments[1])
    || !SLACK_CHANNEL_ID.test(segments[2]) || parsed.search || parsed.hash) return null;
  const nativeUrl = new URL("slack://channel");
  nativeUrl.searchParams.set("team", segments[1]);
  nativeUrl.searchParams.set("id", segments[2]);
  return { protocol: "slack:", url: nativeUrl.href };
}

/**
 * Return a documented native equivalent for a narrowly supported HTTPS URL.
 * This is a pure mapping; it does not inspect the network or the local system.
 * @param {string} rawUrl
 * @returns {NativeAppLink | null}
 */
export function nativeAppLinkForHttps(rawUrl) {
  const notion = canonicalHttpsUrl(rawUrl, new Set(["notion.so", "www.notion.so"]));
  if (notion) return notionLink(notion);
  const linear = canonicalHttpsUrl(rawUrl, new Set(["linear.app"]));
  if (linear) return linearLink(linear);
  const slack = canonicalHttpsUrl(rawUrl, new Set(["app.slack.com"]));
  return slack ? slackLink(slack) : null;
}

/**
 * Resolve the actual OS-registered handler name for a mapped URL. Lookup
 * failures and malformed display names intentionally hide the menu item.
 * @param {string} rawUrl
 * @param {(url: string) => string} getApplicationNameForProtocol
 * @returns {RegisteredNativeAppLink | null}
 */
export function registeredNativeAppLinkForHttps(rawUrl, getApplicationNameForProtocol) {
  const mapped = nativeAppLinkForHttps(rawUrl);
  if (!mapped) return null;
  try {
    const name = getApplicationNameForProtocol(mapped.url).trim();
    if (!name || name.length > 120 || CONTROL_CHARACTERS.test(name)) return null;
    return { ...mapped, name };
  } catch {
    return null;
  }
}
