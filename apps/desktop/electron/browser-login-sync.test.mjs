import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hooks = `
export function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: "electron-stub:login-sync", shortCircuit: true };
  return next(specifier, context);
}
export function load(url, context, next) {
  if (url === "electron-stub:login-sync") return { format: "module", source: "export const session = { fromPartition() { throw new Error('unused'); } };", shortCircuit: true };
  return next(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { createBrowserLoginSync } = await import("./browser-login-sync.mjs");

const NOW = Date.UTC(2026, 8, 4);
const nowSeconds = Math.trunc(NOW / 1000);

function firefoxDatabase(rows, shouldFail, queries) {
  if (shouldFail()) throw new Error("read-failed");
  return {
    prepare(sql) {
      return {
        all(...params) {
          queries.push({ sql, params });
          if (sql.startsWith("PRAGMA table_info")) {
            return ["id", "originAttributes", "name", "value", "host", "path", "expiry", "lastAccessed", "isSecure", "isHttpOnly", "sameSite"].map((name) => ({ name }));
          }
          let selected = rows().filter((row) => row.originAttributes === "");
          if (sql.includes("isHttpOnly = 1")) selected = selected.filter((row) => row.isHttpOnly === 1);
          if (params.length > 0) {
            const sites = params.filter((_value, index) => index % 3 === 0).map(String);
            selected = selected.filter((row) => sites.some((site) => {
              const host = String(row.host).replace(/^\./, "");
              return host === site || host.endsWith(`.${site}`);
            }));
          }
          return selected;
        },
      };
    },
    close() {},
  };
}

function fakeSession() {
  const store = new Map();
  const key = (cookie) => `${cookie.domain}|${cookie.path}|${cookie.name}`;
  return {
    store,
    cleared: [],
    cookies: {
      async set(details) {
        const domain = details.domain ?? new URL(details.url).hostname;
        store.set(key({ domain, path: details.path, name: details.name }), { ...details, domain, hostOnly: details.domain === undefined });
      },
      async get() { return [...store.values()]; },
      async remove(url, name) {
        const hostname = new URL(url).hostname;
        for (const [entry, cookie] of store) {
          if (cookie.name === name && hostname === cookie.domain.replace(/^\./, "")) store.delete(entry);
        }
      },
      async flushStore() {},
    },
    async clearStorageData(options) {
      this.cleared.push(options ?? "all");
      if (!options) store.clear();
    },
  };
}

function setup({ pollIntervalMs = 0, watchSource = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "openwork-login-sync-"));
  const profileDirectory = join(home, "Library", "Application Support", "Firefox", "Profiles", "chosen");
  mkdirSync(profileDirectory, { recursive: true });
  const cookiesPath = join(profileDirectory, "cookies.sqlite");
  writeFileSync(cookiesPath, "synthetic source remains unchanged");
  const statePath = join(home, "openwork", "browser-login-sync.json");
  let sourceRows = [
    { originAttributes: "", name: "sid", value: "first-secret", host: ".example.com", path: "/", expiry: nowSeconds + 3600, lastAccessed: (nowSeconds - 10) * 1e6, isSecure: 1, isHttpOnly: 1, sameSite: 1 },
    { originAttributes: "", name: "theme", value: "dark", host: "app.example.com", path: "/", expiry: nowSeconds + 3600, lastAccessed: 0, isSecure: 0, isHttpOnly: 0, sameSite: 0 },
    { originAttributes: "", name: "auth", value: "bank-secret", host: ".bank.example", path: "/", expiry: nowSeconds + 3600, lastAccessed: (nowSeconds - 20) * 1e6, isSecure: 1, isHttpOnly: 1, sameSite: 2 },
  ];
  let failRead = false;
  let confirmationAllowed = true;
  const queries = [];
  const confirmations = [];
  const browserSession = fakeSession();
  const createService = () => createBrowserLoginSync({
      platform: "darwin",
      home,
      env: {},
      statePath,
      openDatabase: () => firefoxDatabase(() => sourceRows, () => failRead, queries),
      readKeychainPassword: async () => { throw new Error("keychain must not be touched for Firefox"); },
      getSession: () => browserSession,
      now: () => NOW,
      pollIntervalMs,
      watchSource,
      confirmUserAction: async (input) => {
        confirmations.push(input);
        return confirmationAllowed;
      },
    });
  const logins = createService();
  return {
    logins,
    browserSession,
    cookiesPath,
    statePath,
    rows: () => sourceRows,
    setRows: (rows) => { sourceRows = rows; },
    setFailRead: (value) => { failRead = value; },
    setConfirmationAllowed: (value) => { confirmationAllowed = value; },
    queries,
    confirmations,
    createService,
  };
}

async function eventuallyValue(read, matches, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the sync worker.");
}

async function configureExample(logins) {
  await logins.setPolicyAllowed(true);
  const source = (await logins.listSources()).profiles.find((candidate) => candidate.browser === "firefox");
  if (!source) throw new Error("The synthetic Firefox profile was not discovered.");
  const preview = await logins.preview({ sourceId: source.id });
  return { preview, result: await logins.configure({ previewId: preview.previewId, sites: ["example.com"] }) };
}

test("policy permission does not read or configure a source", async () => {
  const { logins, confirmations, queries } = setup();
  await assert.rejects(logins.listSources(), /unavailable/);
  await assert.rejects(logins.preview({ sourceId: "firefox:chosen" }), /unavailable/);
  assert.deepEqual(await logins.getState(), {
    policyAllowed: false,
    configured: false,
    active: false,
    source: null,
    selectedSites: [],
    status: "policy_off",
    lastSyncedAt: null,
    errorCode: null,
    managedCookieCount: 0,
  });
  const permitted = await logins.setPolicyAllowed(true);
  assert.equal(permitted.configured, false);
  assert.equal(permitted.active, false);
  assert.deepEqual(confirmations, []);
  assert.deepEqual(queries, []);
  logins.shutdown();
});

test("denying the user-presence confirmation prevents the first source read", async () => {
  const fixture = setup();
  await fixture.logins.setPolicyAllowed(true);
  const source = (await fixture.logins.listSources()).profiles.find((candidate) => candidate.browser === "firefox");
  if (!source) throw new Error("The synthetic Firefox profile was not discovered.");
  fixture.setConfirmationAllowed(false);
  await assert.rejects(fixture.logins.preview({ sourceId: source.id }), /cancelled/);
  assert.deepEqual(fixture.confirmations.map((entry) => entry.action), ["discover", "read"]);
  assert.deepEqual(fixture.queries, []);
  fixture.logins.shutdown();
});

test("setup exposes no values, keeps sensitive sites unchecked, and reads values only for selected HttpOnly hosts", async () => {
  const { logins, browserSession, statePath, queries, confirmations } = setup();
  const { preview, result } = await configureExample(logins);

  assert.deepEqual(preview.sites.map((site) => [site.site, site.category, site.preselected]), [
    ["example.com", "ordinary", true],
    ["bank.example", "finance", false],
  ]);
  assert.equal(JSON.stringify(preview).includes("first-secret"), false);
  const previewSelect = queries.find((entry) => entry.sql.startsWith("SELECT host, name, path"));
  assert.ok(previewSelect, "preview uses the metadata-only query");
  assert.equal(previewSelect.sql.includes(" value"), false);
  const selectedValueRead = queries.find((entry) => entry.sql.startsWith("SELECT host, name, value"));
  assert.ok(selectedValueRead?.sql.includes("host = ?"), "the value query is scoped to selected hosts");
  assert.ok(selectedValueRead?.sql.includes("isHttpOnly = 1"), "the value query excludes page-readable cookies");
  assert.deepEqual(selectedValueRead?.params.filter((_value, index) => index % 3 === 0), ["example.com"]);
  assert.deepEqual(confirmations.map((entry) => entry.action), ["discover", "read", "configure"]);
  assert.deepEqual(confirmations[2].sites, ["example.com"]);
  assert.deepEqual(result, { sites: [{ site: "example.com", synced: 1, failed: 0, removed: 0 }] });
  assert.deepEqual((await browserSession.cookies.get()).map((cookie) => [cookie.domain, cookie.name]), [[".example.com", "sid"]]);

  const state = await logins.getState();
  assert.equal(state.active, true);
  assert.equal(state.status, "synced");
  assert.deepEqual(state.selectedSites, ["example.com"]);
  assert.equal(state.managedCookieCount, 1);
  const persisted = readFileSync(statePath, "utf8");
  assert.equal(persisted.includes("first-secret"), false);
  assert.equal(persisted.includes("bank-secret"), false);
  logins.shutdown();
});

test("sync updates and removes managed source cookies without touching unselected sites", async () => {
  const fixture = setup();
  await configureExample(fixture.logins);
  const unchangedSource = readFileSync(fixture.cookiesPath, "utf8");

  fixture.setRows(fixture.rows().map((row) => row.name === "sid" ? { ...row, value: "rotated-secret" } : row));
  assert.deepEqual(await fixture.logins.syncNow(), { sites: [{ site: "example.com", synced: 1, failed: 0, removed: 0 }] });
  assert.equal((await fixture.browserSession.cookies.get())[0].value, "rotated-secret");

  fixture.setRows(fixture.rows().filter((row) => row.name !== "sid"));
  assert.deepEqual(await fixture.logins.syncNow(), { sites: [{ site: "example.com", synced: 0, failed: 0, removed: 1 }] });
  assert.deepEqual(await fixture.browserSession.cookies.get(), []);
  assert.equal(readFileSync(fixture.cookiesPath, "utf8"), unchangedSource);
  assert.equal(fixture.rows().some((row) => row.host === ".bank.example"), true, "the unselected source site stays untouched");
  fixture.logins.shutdown();
});

test("the background fingerprint worker follows a changed source without Sync now", async () => {
  const fixture = setup({ pollIntervalMs: 10 });
  await configureExample(fixture.logins);
  fixture.setRows(fixture.rows().map((row) => row.name === "sid" ? { ...row, value: "worker-secret" } : row));
  writeFileSync(fixture.cookiesPath, "synthetic source changed for worker");

  await eventuallyValue(
    async () => (await fixture.browserSession.cookies.get())[0]?.value,
    (value) => value === "worker-secret",
  );
  fixture.logins.shutdown();
});

test("a failed source read keeps the last good target cookie and reports only a value-free code", async () => {
  const fixture = setup();
  await configureExample(fixture.logins);
  fixture.setRows(fixture.rows().filter((row) => row.name !== "sid"));
  fixture.setFailRead(true);

  await assert.rejects(fixture.logins.syncNow(), /read_failed/);
  assert.equal((await fixture.browserSession.cookies.get())[0].value, "first-secret");
  const state = await fixture.logins.getState();
  assert.equal(state.status, "error");
  assert.equal(state.errorCode, "read_failed");
  assert.equal(JSON.stringify(state).includes("first-secret"), false);
  fixture.logins.shutdown();
});

test("pause stops reads and stopping a site prevents it from being restored", async () => {
  const fixture = setup();
  await configureExample(fixture.logins);
  await fixture.logins.pause();
  fixture.setRows(fixture.rows().map((row) => row.name === "sid" ? { ...row, value: "after-pause" } : row));

  await assert.rejects(fixture.logins.syncNow(), /paused or not configured/);
  assert.equal((await fixture.browserSession.cookies.get())[0].value, "first-secret");

  await fixture.logins.setPolicyAllowed(true);
  await fixture.logins.resume();
  assert.equal((await fixture.browserSession.cookies.get())[0].value, "after-pause");
  assert.deepEqual(await fixture.logins.stopSite("example.com"), {
    sites: [{ site: "example.com", synced: 0, failed: 0, removed: 1 }],
  });
  assert.deepEqual(await fixture.browserSession.cookies.get(), []);
  await assert.rejects(fixture.logins.resume(), /Set up browser login sync first/);
  fixture.logins.shutdown();
});

test("policy revocation stops reads but preserves copied state until the user forgets it", async () => {
  const fixture = setup();
  await configureExample(fixture.logins);
  const blocked = await fixture.logins.setPolicyAllowed(false);
  assert.equal(blocked.status, "policy_off");
  assert.equal(blocked.active, false);
  assert.equal((await fixture.browserSession.cookies.get()).length, 1);
  await assert.rejects(fixture.logins.syncNow(), /unavailable/);
  assert.equal((await fixture.browserSession.cookies.get()).length, 1);
  const reallowed = await fixture.logins.setPolicyAllowed(true);
  assert.equal(reallowed.active, false, "policy restoration cannot silently restart a revoked sync");
  await assert.rejects(fixture.logins.syncNow(), /paused or not configured/);
  fixture.logins.shutdown();
});

test("a new Desktop process restores enrollment paused instead of trusting a renderer grant", async () => {
  const fixture = setup();
  await configureExample(fixture.logins);
  fixture.logins.shutdown();

  const restarted = fixture.createService();
  const permitted = await restarted.setPolicyAllowed(true);
  assert.equal(permitted.configured, true);
  assert.equal(permitted.active, false);
  assert.equal(permitted.status, "paused");
  await assert.rejects(restarted.syncNow(), /paused or not configured/);
  restarted.shutdown();
});
