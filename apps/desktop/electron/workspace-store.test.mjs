import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWorkspaceStore } from "./workspace-store.mjs";

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function writeBootstrapConfig(targetPath, config) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function withIsolatedBootstrapStore(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-bootstrap-store-"));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousOverride = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  const previousBundleDir = process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR;
  const previousDevMode = process.env.OPENWORK_DEV_MODE;

  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  delete process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR;
  delete process.env.OPENWORK_DEV_MODE;

  try {
    const module = await import(`./workspace-store.mjs?bootstrap-test=${Date.now()}-${Math.random()}`);
    const createStore = () => module.createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? path.join(root, "userData") : root },
      defaultDenBaseUrl: "https://default.example.com",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });
    const store = createStore();
    return await callback({
      store,
      createStore,
      canonicalPath: path.join(xdg, "openwork", "desktop-bootstrap.json"),
      legacyPath: path.join(home, ".config", "openwork", "desktop-bootstrap.json"),
      root,
      userDataPath: path.join(root, "userData"),
    });
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("XDG_CONFIG_HOME", previousXdg);
    restoreEnv("OPENWORK_DESKTOP_BOOTSTRAP_PATH", previousOverride);
    restoreEnv("OPENWORK_BOOTSTRAP_BUNDLE_DIR", previousBundleDir);
    restoreEnv("OPENWORK_DEV_MODE", previousDevMode);
  }
}

test("recovers missing desktop workspace state from token store paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const oldWorkspace = path.join(root, "old-workspace");
  await mkdir(oldWorkspace, { recursive: true });
  const oldWorkspaceReal = await realpath(oldWorkspace);
  await mkdir(userData, { recursive: true });

  await writeFile(
    path.join(userData, "openwork-server-tokens.json"),
    JSON.stringify({
      version: 1,
      workspaces: {
        "": { updatedAt: 3 },
        [oldWorkspace]: { updatedAt: 2 },
        [path.join(root, "missing")]: { updatedAt: 4 },
      },
    }),
    "utf8",
  );

  const previous = process.env.OPENWORK_SERVER_CONFIG;
  process.env.OPENWORK_SERVER_CONFIG = path.join(root, "missing-server.json");
  try {
    const store = createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://example.test",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    const state = await store.readWorkspaceState();
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.workspaces[0].path, oldWorkspaceReal);
    assert.equal(state.selectedId, state.workspaces[0].id);
    assert.equal(state.watchedId, state.workspaces[0].id);

    const persisted = JSON.parse(await readFile(path.join(userData, "openwork-workspaces.json"), "utf8"));
    assert.equal(persisted.workspaces.length, 1);
    assert.equal(persisted.selectedWorkspaceId, state.workspaces[0].id);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_SERVER_CONFIG;
    else process.env.OPENWORK_SERVER_CONFIG = previous;
  }
});

test("keeps persisted empty desktop workspace state authoritative", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const oldWorkspace = path.join(root, "old-workspace");
  await mkdir(oldWorkspace, { recursive: true });
  await mkdir(userData, { recursive: true });

  await writeFile(
    path.join(userData, "openwork-workspaces.json"),
    JSON.stringify({ selectedId: "", activeId: null, watchedId: null, workspaces: [] }),
    "utf8",
  );
  await writeFile(
    path.join(userData, "openwork-server-tokens.json"),
    JSON.stringify({ version: 1, workspaces: { [oldWorkspace]: { updatedAt: 2 } } }),
    "utf8",
  );

  const previous = process.env.OPENWORK_SERVER_CONFIG;
  process.env.OPENWORK_SERVER_CONFIG = path.join(root, "missing-server.json");
  try {
    const store = createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://example.test",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    const state = await store.readWorkspaceState();
    assert.deepEqual(state.workspaces, []);
    assert.equal(state.selectedId, "");
  } finally {
    restoreEnv("OPENWORK_SERVER_CONFIG", previous);
  }
});

test("prefers server config workspaces when desktop state is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const oldWorkspace = path.join(root, "server-workspace");
  const serverConfig = path.join(root, "server.json");
  await mkdir(oldWorkspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  const oldWorkspaceReal = await realpath(oldWorkspace);

  await writeFile(
    serverConfig,
    JSON.stringify({ workspaces: [{ path: oldWorkspace, name: "From Server" }] }),
    "utf8",
  );
  await writeFile(
    path.join(userData, "openwork-server-tokens.json"),
    JSON.stringify({ version: 1, workspaces: { [path.join(root, "other")]: { updatedAt: 9 } } }),
    "utf8",
  );

  const previous = process.env.OPENWORK_SERVER_CONFIG;
  process.env.OPENWORK_SERVER_CONFIG = serverConfig;
  try {
    const store = createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://example.test",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    const state = await store.readWorkspaceState();
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.workspaces[0].path, oldWorkspaceReal);
    assert.equal(state.workspaces[0].name, "From Server");
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_SERVER_CONFIG;
    else process.env.OPENWORK_SERVER_CONFIG = previous;
  }
});

test("does not create a default workspace when desktop state is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const previousDevMode = process.env.OPENWORK_DEV_MODE;
  const previousServerConfig = process.env.OPENWORK_SERVER_CONFIG;
  process.env.OPENWORK_DEV_MODE = "1";
  process.env.OPENWORK_SERVER_CONFIG = path.join(root, "missing-server.json");
  try {
    const store = createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://example.test",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    const state = await store.readWorkspaceState();
    assert.equal(state.workspaces.length, 0);
    await assert.rejects(readFile(path.join(userData, "openwork-dev-data", "home", "OpenWork", ".opencode", "openwork.json"), "utf8"));
  } finally {
    restoreEnv("OPENWORK_DEV_MODE", previousDevMode);
    restoreEnv("OPENWORK_SERVER_CONFIG", previousServerConfig);
  }
});

test("normalizes recovered remote OpenWork entries before persisting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const serverConfig = path.join(root, "server.json");
  await mkdir(userData, { recursive: true });

  await writeFile(
    serverConfig,
    JSON.stringify({
      workspaces: [
        {
          id: "legacy_one",
          path: "/workspace",
          workspaceType: "remote",
          remoteType: "openwork",
          baseUrl: "https://worker.example.com/workspace/ws_remote",
        },
        {
          id: "legacy_two",
          path: "/workspace",
          workspaceType: "remote",
          remoteType: "openwork",
          baseUrl: "https://worker.example.com/w/ws_remote",
        },
      ],
    }),
    "utf8",
  );

  const previous = process.env.OPENWORK_SERVER_CONFIG;
  process.env.OPENWORK_SERVER_CONFIG = serverConfig;
  try {
    const store = createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://example.test",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    const state = await store.readWorkspaceState();
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.workspaces[0].id, "rem_ws_remote");
    assert.equal(state.workspaces[0].baseUrl, "https://worker.example.com");
    assert.equal(state.workspaces[0].openworkWorkspaceId, "ws_remote");
    assert.equal(state.selectedId, "rem_ws_remote");
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_SERVER_CONFIG;
    else process.env.OPENWORK_SERVER_CONFIG = previous;
  }
});

test("forgetting a local workspace removes its recovery token", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const forgottenWorkspace = path.join(root, "forgotten-workspace");
  const retainedWorkspace = path.join(root, "retained-workspace");
  await mkdir(forgottenWorkspace, { recursive: true });
  await mkdir(retainedWorkspace, { recursive: true });
  await mkdir(userData, { recursive: true });

  await writeFile(
    path.join(userData, "openwork-workspaces.json"),
    JSON.stringify({
      selectedId: "ws_forgotten",
      activeId: "ws_forgotten",
      watchedId: "ws_forgotten",
      workspaces: [
        { id: "ws_forgotten", path: forgottenWorkspace, workspaceType: "local" },
        { id: "ws_retained", path: retainedWorkspace, workspaceType: "local" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(userData, "openwork-server-tokens.json"),
    JSON.stringify({
      version: 1,
      workspaces: {
        [forgottenWorkspace]: { token: "forgotten", updatedAt: 2 },
        [retainedWorkspace]: { token: "retained", updatedAt: 1 },
      },
    }),
    "utf8",
  );

  const store = createWorkspaceStore({
    app: { getPath: (name) => name === "userData" ? userData : root },
    defaultDenBaseUrl: "https://example.test",
    defaultRequireSignin: false,
    forceRequireSignin: false,
  });

  const state = await store.forgetWorkspace("ws_forgotten");
  assert.deepEqual(state.workspaces.map((workspace) => workspace.id), ["ws_retained"]);
  assert.equal(state.selectedId, "");
  assert.equal(state.activeId, null);
  assert.equal(state.watchedId, null);

  const tokens = JSON.parse(await readFile(path.join(userData, "openwork-server-tokens.json"), "utf8"));
  assert.deepEqual(Object.keys(tokens.workspaces), [retainedWorkspace]);
  assert.equal(tokens.workspaces[retainedWorkspace].token, "retained");
});

test("desktop bootstrap prefers a newer canonical writtenAt over stale legacy", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, legacyPath }) => {
    await writeBootstrapConfig(canonicalPath, {
      baseUrl: "https://canonical.example.com",
      requireSignin: false,
      writtenAt: "2026-01-02T00:00:00.000Z",
    });
    await writeBootstrapConfig(legacyPath, {
      baseUrl: "https://legacy.example.com",
      requireSignin: true,
      writtenAt: "2026-01-01T00:00:00.000Z",
    });

    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://canonical.example.com");

    const persisted = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(persisted.baseUrl, "https://canonical.example.com");
  });
});

test("desktop bootstrap migrates a newer legacy writtenAt to canonical", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, legacyPath }) => {
    await writeBootstrapConfig(canonicalPath, {
      baseUrl: "https://canonical.example.com",
      requireSignin: false,
      writtenAt: "2026-01-01T00:00:00.000Z",
    });
    await writeBootstrapConfig(legacyPath, {
      baseUrl: "https://legacy.example.com",
      requireSignin: true,
      writtenAt: "2026-01-02T00:00:00.000Z",
    });

    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://legacy.example.com");
    assert.equal(config.requireSignin, true);

    const migrated = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(migrated.baseUrl, "https://legacy.example.com");
  });
});

test("desktop bootstrap prefers an older legacy organization config over a newer canonical hosted default", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, legacyPath }) => {
    await writeBootstrapConfig(canonicalPath, {
      baseUrl: "https://app.openworklabs.com/api/den/",
      apiBaseUrl: "https://api.unrelated.example",
      requireSignin: false,
      writtenAt: "2026-07-10T13:00:00.000Z",
    });
    await writeBootstrapConfig(legacyPath, {
      baseUrl: "https://openwork.organization.internal.example",
      apiBaseUrl: "https://api.organization.internal.example",
      requireSignin: true,
      writtenAt: "2026-07-09T12:00:00.000Z",
    });

    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://openwork.organization.internal.example");
    const migrated = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(migrated.baseUrl, "https://openwork.organization.internal.example");
  });
});

test("desktop bootstrap keeps an older canonical organization config over a newer legacy hosted default", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, legacyPath }) => {
    await writeBootstrapConfig(canonicalPath, {
      baseUrl: "https://openwork.organization.internal.example",
      apiBaseUrl: "https://api.organization.internal.example",
      requireSignin: true,
      writtenAt: "2026-07-09T12:00:00.000Z",
    });
    await writeBootstrapConfig(legacyPath, {
      baseUrl: "https://api.openworklabs.com/v1/",
      apiBaseUrl: "https://api.unrelated.example",
      requireSignin: false,
      writtenAt: "2026-07-10T13:00:00.000Z",
    });

    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://openwork.organization.internal.example");
    const persisted = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(persisted.baseUrl, "https://openwork.organization.internal.example");
  });
});

test("desktop bootstrap ignores a newer malformed canonical config when legacy is valid", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, legacyPath }) => {
    await writeBootstrapConfig(legacyPath, {
      baseUrl: "https://legacy.organization.internal.example",
      requireSignin: true,
    });
    await mkdir(path.dirname(canonicalPath), { recursive: true });
    await writeFile(canonicalPath, "{ malformed", "utf8");
    const older = new Date("2026-07-09T12:00:00.000Z");
    const newer = new Date("2026-07-10T12:00:00.000Z");
    await utimes(legacyPath, older, older);
    await utimes(canonicalPath, newer, newer);

    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://legacy.organization.internal.example");
    const migrated = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(migrated.baseUrl, "https://legacy.organization.internal.example");
  });
});

test("desktop bootstrap falls back to mtime when writtenAt is missing", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, legacyPath }) => {
    await writeBootstrapConfig(canonicalPath, {
      baseUrl: "https://canonical.example.com",
      requireSignin: false,
    });
    await writeBootstrapConfig(legacyPath, {
      baseUrl: "https://legacy.example.com",
      requireSignin: true,
    });
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-01-02T00:00:00.000Z");
    await utimes(canonicalPath, older, older);
    await utimes(legacyPath, newer, newer);

    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://legacy.example.com");
  });
});

test("desktop bootstrap writes include a fresh writtenAt stamp", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath }) => {
    const config = await store.setDesktopBootstrapConfig({
      baseUrl: "https://canonical.example.com",
      requireSignin: true,
    });
    assert.equal(Number.isFinite(Date.parse(config.writtenAt)), true);

    const persisted = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(persisted.baseUrl, "https://canonical.example.com");
    assert.equal(Number.isFinite(Date.parse(persisted.writtenAt)), true);
  });
});

test("imports the newest organization bootstrap beside a Windows installer when config is absent", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, root }) => {
    const bundleDir = path.join(root, "downloads", "OpenWork-example-org");
    const olderBundleDir = path.join(bundleDir, "older");
    const newerBundleDir = path.join(bundleDir, "latest");
    process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR = bundleDir;
    await mkdir(olderBundleDir, { recursive: true });
    await mkdir(newerBundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "openwork-win-x64-10.0.0.exe"), "signed installer", "utf8");
    await writeBootstrapConfig(path.join(bundleDir, "desktop-bootstrap.json"), {
      baseUrl: "https://app.openworklabs.com/",
      apiBaseUrl: "https://api.openworklabs.com/",
      requireSignin: false,
      writtenAt: "2026-07-10T13:00:00.000Z",
    });
    await writeFile(path.join(olderBundleDir, "openwork-win-x64-9.9.8.exe"), "signed installer", "utf8");
    await writeBootstrapConfig(path.join(olderBundleDir, "desktop-bootstrap.json"), {
      baseUrl: "https://older.internal.example",
      requireSignin: true,
      writtenAt: "2026-07-10T11:00:00.000Z",
    });
    await writeFile(path.join(newerBundleDir, "openwork-win-x64-9.9.9.exe"), "signed installer", "utf8");
    await writeBootstrapConfig(path.join(newerBundleDir, "desktop-bootstrap.json"), {
      baseUrl: "https://openwork.internal.example",
      apiBaseUrl: "https://api.openwork.internal.example",
      requireSignin: true,
      brandAppName: "Example Org Work",
      brandLogoUrl: "https://openwork.internal.example/logo.png",
      brandIconUrl: "https://openwork.internal.example/icon.png",
      writtenAt: "2026-07-10T12:00:00.000Z",
    });

    assert.equal(await store.importBundledDesktopBootstrapConfigIfPreferred(), true);
    const config = await store.getDesktopBootstrapConfig();
    assert.deepEqual(config, {
      baseUrl: "https://openwork.internal.example",
      apiBaseUrl: "https://api.openwork.internal.example",
      requireSignin: true,
      brandAppName: "Example Org Work",
      brandLogoUrl: "https://openwork.internal.example/logo.png",
      brandIconUrl: "https://openwork.internal.example/icon.png",
      writtenAt: "2026-07-10T12:00:00.000Z",
    });
    const persisted = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(persisted.baseUrl, "https://openwork.internal.example");
  });
});

test("ignores a downloaded bootstrap that is not beside a standard installer", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, root }) => {
    const bundleDir = path.join(root, "downloads");
    process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR = bundleDir;
    await writeBootstrapConfig(path.join(bundleDir, "desktop-bootstrap.json"), {
      baseUrl: "https://untrusted.example.com",
      requireSignin: true,
      writtenAt: "2026-07-10T12:00:00.000Z",
    });

    assert.equal(await store.importBundledDesktopBootstrapConfigIfPreferred(), false);
    await assert.rejects(readFile(canonicalPath, "utf8"));
  });
});

test("keeps an installed organization bootstrap across a newer Windows installer bundle and restart", async () => {
  await withIsolatedBootstrapStore(async ({ store, createStore, canonicalPath, root }) => {
    const bundleDir = path.join(root, "downloads");
    process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR = bundleDir;
    await writeBootstrapConfig(canonicalPath, {
      baseUrl: "https://openwork.organization.internal.example",
      requireSignin: true,
      writtenAt: "2026-07-09T12:00:00.000Z",
    });
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "openwork-win-x64-9.9.9.exe"), "signed installer", "utf8");
    await writeBootstrapConfig(path.join(bundleDir, "desktop-bootstrap.json"), {
      baseUrl: "https://app.openworklabs.com/",
      apiBaseUrl: "https://api.openworklabs.com/",
      requireSignin: false,
      writtenAt: "2026-07-10T12:00:00.000Z",
    });

    assert.equal(await store.importBundledDesktopBootstrapConfigIfPreferred(), false);
    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://openwork.organization.internal.example");

    const restartedStore = createStore();
    assert.equal(await restartedStore.importBundledDesktopBootstrapConfigIfPreferred(), false);
    const restartedConfig = await restartedStore.getDesktopBootstrapConfig();
    assert.equal(restartedConfig.baseUrl, "https://openwork.organization.internal.example");
    const persisted = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(persisted.baseUrl, "https://openwork.organization.internal.example");
  });
});

test("keeps and migrates an installed legacy bootstrap beside a newer Windows installer bundle", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, legacyPath, root }) => {
    const bundleDir = path.join(root, "downloads");
    process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR = bundleDir;
    await writeBootstrapConfig(legacyPath, {
      baseUrl: "https://legacy.organization.internal.example",
      requireSignin: true,
      writtenAt: "2026-07-09T12:00:00.000Z",
    });
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "openwork-win-x64-9.9.9.exe"), "signed installer", "utf8");
    await writeBootstrapConfig(path.join(bundleDir, "desktop-bootstrap.json"), {
      baseUrl: "https://app.openworklabs.com/",
      apiBaseUrl: "https://api.openworklabs.com/",
      requireSignin: false,
      writtenAt: "2026-07-10T12:00:00.000Z",
    });

    assert.equal(await store.importBundledDesktopBootstrapConfigIfPreferred(), false);
    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://legacy.organization.internal.example");
    const migrated = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(migrated.baseUrl, "https://legacy.organization.internal.example");
  });
});

test("replaces an installed hosted default with a custom organization Windows bundle", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, root }) => {
    const bundleDir = path.join(root, "downloads");
    process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR = bundleDir;
    await writeBootstrapConfig(canonicalPath, {
      baseUrl: "https://app.openworklabs.com/",
      apiBaseUrl: "https://api.openworklabs.com/",
      requireSignin: false,
      writtenAt: "2026-07-10T13:00:00.000Z",
    });
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "openwork-win-x64-9.9.9.exe"), "signed installer", "utf8");
    await writeBootstrapConfig(path.join(bundleDir, "desktop-bootstrap.json"), {
      baseUrl: "https://custom.organization.internal.example",
      apiBaseUrl: "https://api.custom.organization.internal.example",
      requireSignin: true,
      writtenAt: "2026-07-09T12:00:00.000Z",
    });

    assert.equal(await store.importBundledDesktopBootstrapConfigIfPreferred(), true);
    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://custom.organization.internal.example");
    const persisted = JSON.parse(await readFile(canonicalPath, "utf8"));
    assert.equal(persisted.baseUrl, "https://custom.organization.internal.example");
  });
});

test("clearDesktopBootstrapConfig removes bootstrap files without deleting workspace state", async () => {
  await withIsolatedBootstrapStore(async ({ store, canonicalPath, legacyPath, userDataPath }) => {
    const workspaceStatePath = path.join(userDataPath, "openwork-workspaces.json");
    await writeBootstrapConfig(canonicalPath, {
      baseUrl: "https://canonical.example.com",
      requireSignin: false,
      writtenAt: "2026-01-02T00:00:00.000Z",
    });
    await writeBootstrapConfig(legacyPath, {
      baseUrl: "https://legacy.example.com",
      requireSignin: true,
      writtenAt: "2026-01-01T00:00:00.000Z",
    });
    await mkdir(userDataPath, { recursive: true });
    await writeFile(workspaceStatePath, JSON.stringify({ selectedId: "ws_keep", workspaces: [] }), "utf8");

    await store.clearDesktopBootstrapConfig();

    await assert.rejects(readFile(canonicalPath, "utf8"));
    await assert.rejects(readFile(legacyPath, "utf8"));
    const workspaceState = JSON.parse(await readFile(workspaceStatePath, "utf8"));
    assert.equal(workspaceState.selectedId, "ws_keep");

    const config = await store.getDesktopBootstrapConfig();
    assert.equal(config.baseUrl, "https://default.example.com");
    assert.equal(config.requireSignin, false);
  });
});
