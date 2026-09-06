// @openwork/browser-logins — browser-safe core.
//
// Turning a pile of cookies into the thing a person decides about: "the sites
// I am signed in to". Grouping by site, deciding which sites should stay
// unchecked by default, and mapping cookies onto Electron's cookie shape all
// live here, with no Node or Electron dependency, so the renderer and the main
// process share one definition. Reading and decrypting browser databases is
// in `./node`.
import { getDomain } from "tldts";

/** Cookies with this owner are the user's own logins in the built-in browser. */
export const BUILTIN_BROWSER_PARTITION = "persist:openwork-browser";

export const SITE_CATEGORIES = Object.freeze(["ordinary", "finance", "email", "identity"]);

/** Sites in these categories stay unchecked until the user opts in. */
export const SENSITIVE_CATEGORIES = Object.freeze(["finance", "email", "identity"]);

/** Domains (or suffix matches) of identity providers and account hubs. */
const IDENTITY_DOMAINS = [
  "google.com", "googleapis.com", "microsoft.com", "microsoftonline.com", "live.com", "windows.net",
  "apple.com", "icloud.com", "okta.com", "oktapreview.com", "auth0.com", "onelogin.com", "pingidentity.com", "id.me",
  "pingone.com", "duosecurity.com", "jumpcloud.com", "cloudflareaccess.com", "amazon.com", "amazonaws.com",
  "facebook.com", "github.com", "gitlab.com", "atlassian.com", "yahoo.com",
];

const EMAIL_DOMAINS = [
  "outlook.com", "hotmail.com", "office.com", "protonmail.com", "proton.me", "fastmail.com", "zoho.com",
  "mail.com", "mail.ru", "gmx.com", "gmx.net", "aol.com", "hey.com", "tutanota.com", "tuta.com", "yandex.com",
];

const FINANCE_DOMAINS = [
  "paypal.com", "stripe.com", "wise.com", "revolut.com", "coinbase.com", "binance.com", "kraken.com", "ubs.com",
  "robinhood.com", "wealthfront.com", "betterment.com", "ally.com", "fidelity.com", "schwab.com", "vanguard.com", "morganstanley.com", "jpmorgan.com", "goldmansachs.com", "chase.com", "wellsfargo.com",
  "bankofamerica.com", "citi.com", "citibank.com", "capitalone.com", "americanexpress.com", "discover.com",
  "usbank.com", "pnc.com", "truist.com", "tdbank.com", "hsbc.com", "barclays.co.uk", "lloydsbank.com",
  "natwest.com", "santander.com", "bnpparibas.com", "societegenerale.fr", "creditagricole.fr", "deutsche-bank.de",
  "ing.com", "n26.com", "monzo.com", "starlingbank.com", "venmo.com", "cash.app", "zellepay.com", "intuit.com",
  "quickbooks.com", "xero.com", "brex.com", "ramp.com", "mercury.com", "plaid.com", "etrade.com", "sofi.com",
];

const FINANCE_KEYWORDS = ["bank", "banking", "credit", "invest", "trading", "broker", "wallet", "crypto", "payments", "treasury"];
const EMAIL_HOST_KEYWORDS = ["mail", "webmail", "inbox"];
const IDENTITY_HOST_KEYWORDS = ["account", "auth", "identity", "idp", "login", "signin", "sso"];

function normalizeHost(host) {
  const trimmed = String(host ?? "").trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
}

/**
 * The site a host belongs to (`app.mail.example.com` → `example.com`,
 * `shop.example.co.uk` → `example.co.uk`). IP addresses and single labels
 * are returned unchanged.
 */
export function registrableDomain(host) {
  const clean = normalizeHost(host);
  if (!clean || /^\d{1,3}(\.\d{1,3}){3}$/.test(clean) || clean.includes(":")) return clean;
  return getDomain(clean, { allowPrivateDomains: true }) ?? clean;
}

function matchesDomainList(site, list) {
  return list.some((entry) => site === entry || site.endsWith(`.${entry}`));
}

/** How a site should be treated by default: ordinary, or a category that stays unchecked. */
export function classifySite(site) {
  const domain = normalizeHost(site);
  if (matchesDomainList(domain, FINANCE_DOMAINS)) return "finance";
  if (matchesDomainList(domain, EMAIL_DOMAINS)) return "email";
  if (matchesDomainList(domain, IDENTITY_DOMAINS)) return "identity";
  const firstLabel = domain.split(".")[0] ?? "";
  if (FINANCE_KEYWORDS.some((keyword) => firstLabel.includes(keyword))) return "finance";
  return "ordinary";
}

function classifySiteAndHosts(site, hosts) {
  const category = classifySite(site);
  if (category !== "ordinary") return category;
  const labels = hosts.flatMap((host) => normalizeHost(host).split("."));
  if (labels.some((label) => IDENTITY_HOST_KEYWORDS.includes(label))) return "identity";
  if (labels.some((label) => EMAIL_HOST_KEYWORDS.includes(label))) return "email";
  if (labels.some((label) => FINANCE_KEYWORDS.some((keyword) => label.includes(keyword)))) return "finance";
  return "ordinary";
}

export function isSensitiveCategory(category) {
  return SENSITIVE_CATEGORIES.includes(category);
}

/** Why a category stays unchecked, in the user's words. */
export function categoryReason(category) {
  switch (category) {
    case "finance":
      return "Handles money. Sync only if you want the agent acting on this account.";
    case "email":
      return "Your mailbox. Sync only if you want the agent reading and sending as you.";
    case "identity":
      return "Signs you in to other sites (single sign-on). Syncing it can sign the agent in everywhere it does.";
    default:
      return null;
  }
}

/** A cookie that carries a login rather than a preference or tracker. */
export function looksLikeSessionCookie(cookie) {
  if (cookie.httpOnly) return true;
  return /(sess|auth|token|login|sid|jwt|csrf|xsrf|account|user)/i.test(cookie.name);
}

/**
 * Group normalized cookies into sites the user can pick from. Sites without a
 * single session-looking cookie are left out: nobody needs to "stay signed in"
 * to an ad network.
 */
export function groupCookiesIntoSites(cookies, { now = Date.now() } = {}) {
  const bySite = new Map();
  for (const cookie of cookies) {
    const site = registrableDomain(cookie.host);
    if (!site) continue;
    if (cookie.expiresAt !== null && cookie.expiresAt * 1000 < now) continue;
    let entry = bySite.get(site);
    if (!entry) {
      entry = { site, cookieCount: 0, sessionCookieCount: 0, hosts: new Set(), lastUsedAt: null };
      bySite.set(site, entry);
    }
    entry.cookieCount += 1;
    if (looksLikeSessionCookie(cookie)) entry.sessionCookieCount += 1;
    entry.hosts.add(normalizeHost(cookie.host));
    if (cookie.lastAccessedAt !== null && (entry.lastUsedAt === null || cookie.lastAccessedAt > entry.lastUsedAt)) {
      entry.lastUsedAt = cookie.lastAccessedAt;
    }
  }
  return [...bySite.values()]
    .filter((entry) => entry.sessionCookieCount > 0)
    .map((entry) => {
      const hosts = [...entry.hosts].sort();
      const category = classifySiteAndHosts(entry.site, hosts);
      return {
        site: entry.site,
        hosts,
        cookieCount: entry.cookieCount,
        sessionCookieCount: entry.sessionCookieCount,
        lastUsedAt: entry.lastUsedAt,
        category,
        preselected: !isSensitiveCategory(category),
        reason: categoryReason(category),
      };
    })
    .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || left.site.localeCompare(right.site));
}

/** Cookies that belong to one of the chosen sites. */
export function cookiesForSites(cookies, sites) {
  const chosen = new Set(sites.map((site) => normalizeHost(site)));
  return cookies.filter((cookie) => chosen.has(registrableDomain(cookie.host)));
}

/**
 * Electron's `session.cookies.set` shape. Host-only cookies omit `domain`
 * (Electron would otherwise turn them into domain cookies); domain cookies keep
 * their leading dot.
 */
export function toElectronCookie(cookie) {
  const host = normalizeHost(cookie.host);
  const details = {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
  if (!cookie.hostOnly) details.domain = `.${host}`;
  if (cookie.expiresAt !== null) details.expirationDate = cookie.expiresAt;
  return details;
}

/** Electron's `session.cookies.get` shape back into the normalized cookie. */
export function fromElectronCookie(cookie) {
  const domain = String(cookie.domain ?? "");
  return {
    host: domain,
    hostOnly: cookie.hostOnly === true || !domain.startsWith("."),
    name: String(cookie.name ?? ""),
    value: String(cookie.value ?? ""),
    path: String(cookie.path ?? "/"),
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: typeof cookie.sameSite === "string" ? cookie.sameSite : "unspecified",
    expiresAt: typeof cookie.expirationDate === "number" ? cookie.expirationDate : null,
    lastAccessedAt: null,
  };
}

/** Which browsers can be synced from on a platform, and why the others cannot. */
export function importSourceAvailability(platform) {
  const chromiumBlocked = platform === "win32"
    ? "Chrome and Edge on Windows lock their cookies to the browser (app-bound encryption)."
    : platform === "linux"
      ? "Chrome and Edge on Linux keep their key in the system keyring; not supported yet."
      : null;
  return [
    { browser: "chrome", label: "Google Chrome", importable: chromiumBlocked === null, reason: chromiumBlocked },
    { browser: "edge", label: "Microsoft Edge", importable: chromiumBlocked === null, reason: chromiumBlocked },
    { browser: "brave", label: "Brave", importable: chromiumBlocked === null, reason: chromiumBlocked },
    { browser: "chromium", label: "Chromium", importable: chromiumBlocked === null, reason: chromiumBlocked },
    { browser: "firefox", label: "Firefox", importable: true, reason: null },
    ...(platform === "darwin"
      ? [{ browser: "safari", label: "Safari", importable: false, reason: "Safari keeps its cookies where only Safari can read them without Full Disk Access." }]
      : []),
  ];
}
