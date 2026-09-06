// @openwork/browser-logins/node — reading the browsers' own cookie stores.
//
// Node-only: key derivation, decryption, row mapping, and profile discovery.
// Nothing here opens a database; callers hand in a `query(sql)` function from
// whatever SQLite driver they run (better-sqlite3 in Electron, bun:sqlite in
// tests) over a *copy* of the browser's file. Values never leave the process
// that calls this.

import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Microseconds between 1601-01-01 (Chromium's epoch) and 1970-01-01. */
const CHROMIUM_EPOCH_OFFSET_US = 11_644_473_600n * 1_000_000n;
const CHROMIUM_SALT = "saltysalt";
const CHROMIUM_IV = Buffer.alloc(16, 0x20);
const CHROMIUM_KEY_ITERATIONS_MAC = 1003;
const CHROMIUM_KEY_ITERATIONS_LINUX = 1;
/** Cookie DB schema version from which Chromium prefixes plaintext with SHA-256(host_key). */
export const CHROMIUM_HOST_HASH_MIN_VERSION = 24;

export const CHROMIUM_BROWSERS = Object.freeze({
  chrome: { label: "Google Chrome", keychainService: "Chrome Safe Storage", darwin: "Google/Chrome", linux: "google-chrome", win32: "Google\\Chrome\\User Data" },
  edge: { label: "Microsoft Edge", keychainService: "Microsoft Edge Safe Storage", darwin: "Microsoft Edge", linux: "microsoft-edge", win32: "Microsoft\\Edge\\User Data" },
  brave: { label: "Brave", keychainService: "Brave Safe Storage", darwin: "BraveSoftware/Brave-Browser", linux: "BraveSoftware/Brave-Browser", win32: "BraveSoftware\\Brave-Browser\\User Data" },
  chromium: { label: "Chromium", keychainService: "Chromium Safe Storage", darwin: "Chromium", linux: "chromium", win32: "Chromium\\User Data" },
});

export function chromiumTimeToUnixSeconds(value) {
  const micros = BigInt(Math.trunc(Number(value ?? 0)));
  if (micros <= 0n) return null;
  return Number((micros - CHROMIUM_EPOCH_OFFSET_US) / 1_000_000n);
}

/** Derive Chromium's AES key from the OS-stored password (macOS Keychain / Linux keyring). */
export function deriveChromiumKey(password, { platform = "darwin" } = {}) {
  const iterations = platform === "linux" ? CHROMIUM_KEY_ITERATIONS_LINUX : CHROMIUM_KEY_ITERATIONS_MAC;
  return pbkdf2Sync(password, CHROMIUM_SALT, iterations, 16, "sha1");
}

/**
 * Decrypt one Chromium `encrypted_value`. Plaintext values (no `v10`/`v11`
 * prefix) pass through; `v20` is Windows app-bound encryption and is refused.
 */
export function decryptChromiumValue(encrypted, key, { hostKey, hashPrefixed }) {
  const buffer = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted ?? []);
  if (buffer.length === 0) return "";
  const prefix = buffer.subarray(0, 3).toString("latin1");
  if (prefix === "v20") throw new Error("app-bound-encryption");
  if (prefix !== "v10" && prefix !== "v11") return buffer.toString("utf8");
  const decipher = createDecipheriv("aes-128-cbc", key, CHROMIUM_IV);
  const plain = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
  if (!hashPrefixed) return plain.toString("utf8");
  if (plain.length < 32) throw new Error("host-hash-mismatch");
  const expected = createHash("sha256").update(String(hostKey ?? "")).digest();
  if (!plain.subarray(0, 32).equals(expected)) throw new Error("host-hash-mismatch");
  return plain.subarray(32).toString("utf8");
}

function chromiumSameSite(value) {
  switch (Number(value)) {
    case 0: return "no_restriction";
    case 1: return "lax";
    case 2: return "strict";
    default: return "unspecified";
  }
}

/** Map one row of Chromium's `cookies` table to a normalized cookie. */
export function chromiumCookieFromRow(row, decryptValue) {
  const host = String(row.host_key ?? "");
  const value = row.encrypted_value && Buffer.byteLength(row.encrypted_value) > 0
    ? decryptValue(row.encrypted_value, host)
    : String(row.value ?? "");
  return {
    host,
    hostOnly: !host.startsWith("."),
    name: String(row.name ?? ""),
    value,
    path: String(row.path ?? "/"),
    secure: Number(row.is_secure) === 1,
    httpOnly: Number(row.is_httponly) === 1,
    sameSite: chromiumSameSite(row.samesite),
    expiresAt: Number(row.has_expires) === 1 || Number(row.is_persistent) === 1 ? chromiumTimeToUnixSeconds(row.expires_utc) : null,
    lastAccessedAt: chromiumTimeToUnixSeconds(row.last_access_utc),
  };
}

/** Map Chromium cookie metadata without selecting or decrypting its value. */
export function chromiumCookieMetadataFromRow(row) {
  const host = String(row.host_key ?? "");
  return {
    host,
    hostOnly: !host.startsWith("."),
    name: String(row.name ?? ""),
    value: "",
    path: String(row.path ?? "/"),
    secure: Number(row.is_secure) === 1,
    httpOnly: Number(row.is_httponly) === 1,
    sameSite: chromiumSameSite(row.samesite),
    expiresAt: Number(row.has_expires) === 1 || Number(row.is_persistent) === 1 ? chromiumTimeToUnixSeconds(row.expires_utc) : null,
    lastAccessedAt: chromiumTimeToUnixSeconds(row.last_access_utc),
  };
}

function whereClause(clauses) {
  return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function addSelectedSiteFilter(clauses, params, column, sites) {
  const selectedSites = Array.isArray(sites) ? [...new Set(sites.map(String).filter(Boolean))] : null;
  if (!selectedSites) return null;
  if (selectedSites.length === 0) return [];
  const siteClauses = [];
  for (const site of selectedSites) {
    siteClauses.push(`(${column} = ? OR ${column} = ? OR ${column} LIKE ?)`);
    params.push(site, `.${site}`, `%.${site}`);
  }
  clauses.push(`(${siteClauses.join(" OR ")})`);
  return selectedSites;
}

/** Read Chromium metadata only. No cookie-value column enters this query. */
export function readChromiumCookieMetadata(query) {
  const columns = new Set(query("PRAGMA table_info(cookies)").map((column) => String(column.name)));
  const clauses = columns.has("top_frame_site_key") ? ["top_frame_site_key = ''"] : [];
  const rows = query(`SELECT host_key, name, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, samesite FROM cookies${whereClause(clauses)}`);
  return rows.map((row) => chromiumCookieMetadataFromRow(row));
}

/**
 * Read every first-party cookie from a Chromium cookie database copy.
 * `query(sql)` returns rows; `key` is the derived AES key (null when values are
 * stored in plaintext). Partitioned (CHIPS) cookies are skipped: they only
 * exist inside a specific embedding site.
 */
export function readChromiumCookies(query, { key, version = null, sites = null, httpOnlyOnly = false }) {
  const resolvedVersion = version ?? readChromiumSchemaVersion(query);
  const hashPrefixed = resolvedVersion !== null && resolvedVersion >= CHROMIUM_HOST_HASH_MIN_VERSION;
  const columns = new Set(query("PRAGMA table_info(cookies)").map((column) => String(column.name)));
  const clauses = columns.has("top_frame_site_key") ? ["top_frame_site_key = ''"] : [];
  const params = [];
  const selectedSites = addSelectedSiteFilter(clauses, params, "host_key", sites);
  if (selectedSites && selectedSites.length === 0) return { cookies: [], undecryptable: 0, version: resolvedVersion };
  if (httpOnlyOnly) clauses.push("is_httponly = 1");
  const rows = query(
    `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, samesite FROM cookies${whereClause(clauses)}`,
    params,
  );
  const cookies = [];
  let undecryptable = 0;
  for (const row of rows) {
    try {
      cookies.push(chromiumCookieFromRow(row, (encrypted, hostKey) => {
        if (!key) throw new Error("no-key");
        return decryptChromiumValue(encrypted, key, { hostKey, hashPrefixed });
      }));
    } catch {
      undecryptable += 1;
    }
  }
  return { cookies, undecryptable, version: resolvedVersion };
}

export function readChromiumSchemaVersion(query) {
  try {
    const row = query("SELECT value FROM meta WHERE key = 'version'")[0];
    const version = Number(row?.value);
    return Number.isFinite(version) ? version : null;
  } catch {
    return null;
  }
}

function firefoxSameSite(value) {
  switch (Number(value)) {
    case 0: return "no_restriction";
    case 1: return "lax";
    case 2: return "strict";
    default: return "unspecified";
  }
}

/** Map one row of Firefox's `moz_cookies` table to a normalized cookie. */
export function firefoxCookieFromRow(row) {
  const host = String(row.host ?? "");
  return {
    host,
    hostOnly: !host.startsWith("."),
    name: String(row.name ?? ""),
    value: String(row.value ?? ""),
    path: String(row.path ?? "/"),
    secure: Number(row.isSecure) === 1,
    httpOnly: Number(row.isHttpOnly) === 1,
    sameSite: firefoxSameSite(row.sameSite),
    expiresAt: Number(row.expiry) > 0 ? Number(row.expiry) : null,
    lastAccessedAt: Number(row.lastAccessed) > 0 ? Math.trunc(Number(row.lastAccessed) / 1_000_000) : null,
  };
}

/** Map Firefox cookie metadata without selecting its plaintext value. */
export function firefoxCookieMetadataFromRow(row) {
  return { ...firefoxCookieFromRow({ ...row, value: "" }), value: "" };
}

/** Read Firefox metadata only. No cookie-value column enters this query. */
export function readFirefoxCookieMetadata(query) {
  const columns = new Set(query("PRAGMA table_info(moz_cookies)").map((column) => String(column.name)));
  const clauses = columns.has("originAttributes") ? ["originAttributes = ''"] : [];
  const rows = query(`SELECT host, name, path, expiry, lastAccessed, isSecure, isHttpOnly, sameSite FROM moz_cookies${whereClause(clauses)}`);
  return rows.map((row) => firefoxCookieMetadataFromRow(row));
}

/** Read every cookie from a Firefox `cookies.sqlite` copy (values are plaintext). */
export function readFirefoxCookies(query, { sites = null, httpOnlyOnly = false } = {}) {
  const columns = new Set(query("PRAGMA table_info(moz_cookies)").map((column) => String(column.name)));
  // originAttributes carries container/partition keys; keep the default context only.
  const clauses = columns.has("originAttributes") ? ["originAttributes = ''"] : [];
  const params = [];
  const selectedSites = addSelectedSiteFilter(clauses, params, "host", sites);
  if (selectedSites && selectedSites.length === 0) return { cookies: [], undecryptable: 0, version: null };
  if (httpOnlyOnly) clauses.push("isHttpOnly = 1");
  const rows = query(
    `SELECT host, name, value, path, expiry, lastAccessed, isSecure, isHttpOnly, sameSite FROM moz_cookies${whereClause(clauses)}`,
    params,
  );
  return { cookies: rows.map((row) => firefoxCookieFromRow(row)), undecryptable: 0, version: null };
}

function safeReaddir(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileIfExists(path) {
  try {
    return existsSync(path) && statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

function chromiumUserDataDir(browser, { platform, home, localAppData }) {
  const spec = CHROMIUM_BROWSERS[browser];
  if (!spec) return null;
  if (platform === "darwin") return join(home, "Library", "Application Support", spec.darwin);
  if (platform === "linux") return join(home, ".config", spec.linux);
  if (platform === "win32") return localAppData ? join(localAppData, spec.win32) : null;
  return null;
}

/**
 * Chromium-family profiles on this machine. The cookie file lives at
 * `<Profile>/Cookies` on older profiles and `<Profile>/Network/Cookies` on
 * newer ones; both are checked.
 */
export function chromiumProfileCandidates({ platform, home, localAppData = null }) {
  const candidates = [];
  for (const browser of Object.keys(CHROMIUM_BROWSERS)) {
    const userData = chromiumUserDataDir(browser, { platform, home, localAppData });
    if (!userData) continue;
    for (const entry of safeReaddir(userData)) {
      if (!entry.isDirectory() || !(entry.name === "Default" || /^Profile \d+$/.test(entry.name))) continue;
      const profileDir = join(userData, entry.name);
      const cookies = fileIfExists(join(profileDir, "Network", "Cookies")) ?? fileIfExists(join(profileDir, "Cookies"));
      if (!cookies) continue;
      candidates.push({
        id: `${browser}:${entry.name}`,
        browser,
        label: CHROMIUM_BROWSERS[browser].label,
        profile: entry.name,
        path: cookies,
        keychainService: CHROMIUM_BROWSERS[browser].keychainService,
      });
    }
  }
  return candidates;
}

function firefoxProfilesDirs({ platform, home, appData = null }) {
  if (platform === "darwin") return [join(home, "Library", "Application Support", "Firefox", "Profiles")];
  if (platform === "linux") return [join(home, ".mozilla", "firefox"), join(home, "snap", "firefox", "common", ".mozilla", "firefox")];
  if (platform === "win32") return appData ? [join(appData, "Mozilla", "Firefox", "Profiles")] : [];
  return [];
}

/** Firefox profiles on this machine (any profile directory holding cookies.sqlite). */
export function firefoxProfileCandidates({ platform, home, appData = null }) {
  const candidates = [];
  for (const root of firefoxProfilesDirs({ platform, home, appData })) {
    for (const entry of safeReaddir(root)) {
      if (!entry.isDirectory()) continue;
      const cookies = fileIfExists(join(root, entry.name, "cookies.sqlite"));
      if (!cookies) continue;
      const rootId = createHash("sha256").update(root).digest("hex").slice(0, 10);
      candidates.push({
        id: `firefox:${rootId}:${entry.name}`,
        browser: "firefox",
        label: "Firefox",
        profile: entry.name,
        path: cookies,
        keychainService: null,
      });
    }
  }
  return candidates;
}

/** Sidecar files that must travel with a SQLite copy so the copy is consistent. */
export function sqliteCompanionFiles(path) {
  return [`${path}-wal`, `${path}-journal`, `${path}-shm`].filter((candidate) => fileIfExists(candidate) !== null);
}
