import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifySite,
  cookiesForSites,
  fromElectronCookie,
  groupCookiesIntoSites,
  importSourceAvailability,
  registrableDomain,
  toElectronCookie,
} from "../index.mjs";
import {
  chromiumProfileCandidates,
  chromiumTimeToUnixSeconds,
  decryptChromiumValue,
  deriveChromiumKey,
  firefoxProfileCandidates,
  readChromiumCookies,
  readFirefoxCookies,
} from "../node.mjs";

const NOW = Date.UTC(2026, 8, 4) ; // 2026-09-04
const nowSeconds = Math.trunc(NOW / 1000);

function cookie(overrides) {
  return {
    host: ".example.com",
    hostOnly: false,
    name: "sid",
    value: "abc",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expiresAt: nowSeconds + 3600,
    lastAccessedAt: nowSeconds - 60,
    ...overrides,
  };
}

describe("sites", () => {
  test("hosts group under their registrable domain, including two-part public suffixes", () => {
    expect(registrableDomain("app.mail.example.com")).toBe("example.com");
    expect(registrableDomain(".shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("team-a.github.io")).toBe("team-a.github.io");
    expect(registrableDomain("team-b.github.io")).toBe("team-b.github.io");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });

  test("finance, email, and identity sites are recognised and stay unchecked", () => {
    expect(classifySite("chase.com")).toBe("finance");
    expect(classifySite("mybank.example")).toBe("finance");
    expect(classifySite("proton.me")).toBe("email");
    expect(classifySite("okta.com")).toBe("identity");
    expect(classifySite("id.me")).toBe("identity");
    expect(classifySite("mail.ru")).toBe("email");
    expect(classifySite("ubs.com")).toBe("finance");
    expect(classifySite("wealthfront.com")).toBe("finance");
    expect(classifySite("betterment.com")).toBe("finance");
    expect(classifySite("morganstanley.com")).toBe("finance");
    expect(classifySite("ally.com")).toBe("finance");
    expect(classifySite("jpmorgan.com")).toBe("finance");
    expect(classifySite("goldmansachs.com")).toBe("finance");
    expect(classifySite("login.microsoftonline.com")).toBe("identity");
    expect(classifySite("news.ycombinator.com")).toBe("ordinary");
  });

  test("only sites with a session-looking cookie are offered, trackers and expired cookies are not", () => {
    const sites = groupCookiesIntoSites([
      cookie({ host: ".example.com", name: "sid", lastAccessedAt: nowSeconds - 10 }),
      cookie({ host: "app.example.com", name: "theme", httpOnly: false, secure: false }),
      cookie({ host: ".adnetwork.test", name: "uid", httpOnly: false }),
      cookie({ host: ".old.test", name: "sid", expiresAt: nowSeconds - 5 }),
      cookie({ host: ".chase.com", name: "auth", lastAccessedAt: nowSeconds - 5000 }),
    ], { now: NOW });

    expect(sites.map((site) => site.site)).toEqual(["example.com", "chase.com"]);
    expect(sites[0]).toMatchObject({
      hosts: ["app.example.com", "example.com"],
      cookieCount: 2,
      sessionCookieCount: 1,
      category: "ordinary",
      preselected: true,
      reason: null,
    });
    expect(sites[1]).toMatchObject({ category: "finance", preselected: false });
    expect(sites[1].reason).toContain("money");
    expect(groupCookiesIntoSites([
      cookie({ host: "login.example.net", name: "sid" }),
    ], { now: NOW })[0]).toMatchObject({ category: "identity", preselected: false });
  });

  test("choosing sites selects every cookie of those sites and nothing else", () => {
    const all = [cookie({ host: ".example.com" }), cookie({ host: "app.example.com", name: "x" }), cookie({ host: ".other.test" })];
    expect(cookiesForSites(all, ["example.com"]).map((entry) => entry.host)).toEqual([".example.com", "app.example.com"]);
  });
});

describe("Electron cookie mapping", () => {
  test("domain cookies keep their scope, host-only cookies omit domain, session cookies omit expiry", () => {
    expect(toElectronCookie(cookie())).toEqual({
      url: "https://example.com/",
      name: "sid",
      value: "abc",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: nowSeconds + 3600,
    });
    const hostOnly = toElectronCookie(cookie({ host: "app.example.com", hostOnly: true, expiresAt: null, secure: false, path: "/x" }));
    expect(hostOnly.url).toBe("http://app.example.com/x");
    expect(hostOnly).not.toHaveProperty("domain");
    expect(hostOnly).not.toHaveProperty("expirationDate");
  });

  test("cookies read back from Electron round-trip into the normalized shape", () => {
    expect(fromElectronCookie({ domain: ".example.com", name: "sid", value: "v", path: "/", secure: true, httpOnly: true, sameSite: "strict", expirationDate: 42 }))
      .toMatchObject({ host: ".example.com", hostOnly: false, sameSite: "strict", expiresAt: 42 });
    expect(fromElectronCookie({ domain: "app.example.com", hostOnly: true, name: "a", value: "b" }))
      .toMatchObject({ hostOnly: true, sameSite: "unspecified", expiresAt: null });
  });
});

describe("Chromium store", () => {
  const password = "keychain-secret";
  const key = deriveChromiumKey(password);

  function encrypt(plaintext, { hostKey = null } = {}) {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const body = hostKey === null
      ? Buffer.from(plaintext, "utf8")
      : Buffer.concat([createHash("sha256").update(hostKey).digest(), Buffer.from(plaintext, "utf8")]);
    return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(body), cipher.final()]);
  }

  test("Chromium timestamps convert from the 1601 epoch", () => {
    expect(chromiumTimeToUnixSeconds(11_644_473_600n * 1_000_000n + 1_000_000n)).toBe(1);
    expect(chromiumTimeToUnixSeconds(0)).toBe(null);
  });

  test("v10 values decrypt, the schema-24 host hash is stripped, app-bound values are refused", () => {
    expect(decryptChromiumValue(encrypt("hello"), key, { hostKey: ".example.com", hashPrefixed: false })).toBe("hello");
    expect(decryptChromiumValue(encrypt("hello", { hostKey: ".example.com" }), key, { hostKey: ".example.com", hashPrefixed: true })).toBe("hello");
    expect(() => decryptChromiumValue(encrypt("hello", { hostKey: ".other.test" }), key, { hostKey: ".example.com", hashPrefixed: true })).toThrow("host-hash-mismatch");
    expect(decryptChromiumValue(Buffer.from("plain"), key, { hostKey: "", hashPrefixed: true })).toBe("plain");
    expect(() => decryptChromiumValue(Buffer.from("v20xxxx", "latin1"), key, { hostKey: "", hashPrefixed: true })).toThrow("app-bound-encryption");
  });

  test("a Chromium cookie database reads into normalized cookies and skips partitioned rows", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE meta (key TEXT, value TEXT)");
    db.run("INSERT INTO meta VALUES ('version', '24')");
    db.run(`CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
      path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, samesite INTEGER)`);
    const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const expires = Number(11_644_473_600n * 1_000_000n) + (nowSeconds + 3600) * 1_000_000;
    insert.run(1, ".example.com", "", "sid", "", encrypt("secret", { hostKey: ".example.com" }), "/", expires, 1, 1, expires, 1, 1, 1);
    insert.run(2, "app.example.com", "", "theme", "dark", null, "/", 0, 0, 0, 0, 0, 0, -1);
    insert.run(3, ".embedded.test", "https://top.test", "partitioned", "", encrypt("x", { hostKey: ".embedded.test" }), "/", expires, 1, 1, expires, 1, 1, 0);
    const query = (sql, params = []) => db.query(sql).all(...params);

    const result = readChromiumCookies(query, { key });

    expect(result.version).toBe(24);
    expect(result.undecryptable).toBe(0);
    expect(result.cookies).toEqual([
      { host: ".example.com", hostOnly: false, name: "sid", value: "secret", path: "/", secure: true, httpOnly: true, sameSite: "lax", expiresAt: nowSeconds + 3600, lastAccessedAt: nowSeconds + 3600 },
      { host: "app.example.com", hostOnly: true, name: "theme", value: "dark", path: "/", secure: false, httpOnly: false, sameSite: "unspecified", expiresAt: null, lastAccessedAt: null },
    ]);
    expect(readChromiumCookies(query, { key, sites: ["example.com"], httpOnlyOnly: true }).cookies.map((entry) => entry.name)).toEqual(["sid"]);
  });

  test("a wrong key counts rows as undecryptable instead of failing the read", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE meta (key TEXT, value TEXT)");
    db.run("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, samesite INTEGER)");
    db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(".example.com", "sid", "", encrypt("secret"), "/", 0, 1, 1, 0, 0, 0, 1);
    const result = readChromiumCookies((sql) => db.query(sql).all(), { key: deriveChromiumKey("other") });
    expect(result.cookies).toEqual([]);
    expect(result.undecryptable).toBe(1);
  });
});

describe("Firefox store", () => {
  test("a Firefox cookie database reads into normalized cookies and keeps only the default container", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE moz_cookies (id INTEGER, originAttributes TEXT, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)");
    const insert = db.prepare("INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(1, "", "sid", "secret", ".example.org", "/", nowSeconds + 60, (nowSeconds - 5) * 1_000_000, 0, 1, 1, 2);
    insert.run(2, "^userContextId=1", "sid", "container", ".example.org", "/", nowSeconds + 60, 0, 0, 1, 1, 0);
    insert.run(3, "", "sid", "other-secret", ".other.test", "/", nowSeconds + 60, 0, 0, 1, 1, 0);

    const query = (sql, params = []) => db.query(sql).all(...params);
    const result = readFirefoxCookies(query, { sites: ["example.org"], httpOnlyOnly: true });

    expect(result.cookies).toEqual([
      { host: ".example.org", hostOnly: false, name: "sid", value: "secret", path: "/", secure: true, httpOnly: true, sameSite: "strict", expiresAt: nowSeconds + 60, lastAccessedAt: nowSeconds - 5 },
    ]);
  });
});

describe("profile discovery", () => {
  test("finds Chromium profiles at either cookie location and Firefox profiles by directory", () => {
    const home = mkdtempSync(join(tmpdir(), "browser-logins-"));
    const chrome = join(home, "Library", "Application Support", "Google", "Chrome");
    mkdirSync(join(chrome, "Default", "Network"), { recursive: true });
    writeFileSync(join(chrome, "Default", "Network", "Cookies"), "");
    mkdirSync(join(chrome, "Profile 2"), { recursive: true });
    writeFileSync(join(chrome, "Profile 2", "Cookies"), "");
    mkdirSync(join(chrome, "System Profile"), { recursive: true });
    writeFileSync(join(chrome, "System Profile", "Cookies"), "");
    const firefoxRoot = join(home, "Library", "Application Support", "Firefox", "Profiles");
    const firefox = join(firefoxRoot, "abc.default-release");
    mkdirSync(firefox, { recursive: true });
    writeFileSync(join(firefox, "cookies.sqlite"), "");

    expect(chromiumProfileCandidates({ platform: "darwin", home }).map(({ id, path, keychainService }) => ({ id, path, keychainService }))).toEqual([
      { id: "chrome:Default", path: join(chrome, "Default", "Network", "Cookies"), keychainService: "Chrome Safe Storage" },
      { id: "chrome:Profile 2", path: join(chrome, "Profile 2", "Cookies"), keychainService: "Chrome Safe Storage" },
    ]);
    expect(firefoxProfileCandidates({ platform: "darwin", home })).toEqual([
      { id: `firefox:${createHash("sha256").update(firefoxRoot).digest("hex").slice(0, 10)}:abc.default-release`, browser: "firefox", label: "Firefox", profile: "abc.default-release", path: join(firefox, "cookies.sqlite"), keychainService: null },
    ]);
  });

  test("Firefox source ids distinguish native and Snap roots with the same profile name", () => {
    const home = mkdtempSync(join(tmpdir(), "browser-logins-linux-"));
    const roots = [
      join(home, ".mozilla", "firefox"),
      join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    ];
    for (const root of roots) {
      const profile = join(root, "shared.default");
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, "cookies.sqlite"), "");
    }
    const profiles = firefoxProfileCandidates({ platform: "linux", home });
    expect(profiles.map((profile) => profile.id)).toHaveLength(2);
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(2);
  });

  test("availability explains what cannot be synced on each platform", () => {
    const windows = importSourceAvailability("win32");
    expect(windows.find((entry) => entry.browser === "chrome")).toMatchObject({ importable: false });
    expect(windows.find((entry) => entry.browser === "firefox")).toMatchObject({ importable: true });
    expect(windows.some((entry) => entry.browser === "safari")).toBe(false);
    const mac = importSourceAvailability("darwin");
    expect(mac.find((entry) => entry.browser === "chrome")).toMatchObject({ importable: true });
    expect(mac.find((entry) => entry.browser === "safari")).toMatchObject({ importable: false });
  });
});
