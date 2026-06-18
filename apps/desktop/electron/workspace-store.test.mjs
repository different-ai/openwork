import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWorkspaceStore } from "./workspace-store.mjs";

test("recovers empty desktop workspace state from token store paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const oldWorkspace = path.join(root, "old-workspace");
  await mkdir(oldWorkspace, { recursive: true });
  const oldWorkspaceReal = await realpath(oldWorkspace);
  await mkdir(userData, { recursive: true });

  await writeFile(
    path.join(userData, "openwork-workspaces.json"),
    JSON.stringify({ selectedId: "ws_missing", activeId: "ws_missing", watchedId: null, workspaces: [] }),
    "utf8",
  );
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
    setEnv("OPENWORK_SERVER_CONFIG", previous);
  }
});

test("prefers server config workspaces when desktop state is empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const oldWorkspace = path.join(root, "server-workspace");
  const serverConfig = path.join(root, "server.json");
  await mkdir(oldWorkspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  const oldWorkspaceReal = await realpath(oldWorkspace);

  await writeFile(
    path.join(userData, "openwork-workspaces.json"),
    JSON.stringify({ selectedId: "", activeId: null, watchedId: null, workspaces: [] }),
    "utf8",
  );
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
    setEnv("OPENWORK_SERVER_CONFIG", previous);
  }
});

test("normalizes recovered remote OpenWork entries before persisting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "userData");
  const serverConfig = path.join(root, "server.json");
  await mkdir(userData, { recursive: true });

  await writeFile(
    path.join(userData, "openwork-workspaces.json"),
    JSON.stringify({ selectedId: "", activeId: null, watchedId: null, workspaces: [] }),
    "utf8",
  );
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
    setEnv("OPENWORK_SERVER_CONFIG", previous);
  }
});

test("workspace store reads managed desktop bootstrap before user fallback", async () => {
  const previousProgramData = process.env.ProgramData;
  const previousProgramdata = process.env.PROGRAMDATA;
  const previousAppData = process.env.APPDATA;
  const previousOverride = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  const previousDevMode = process.env.OPENWORK_DEV_MODE;
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "user-data");
  const programData = path.join(root, "program-data");
  const appData = path.join(root, "app-data");

  try {
    delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
    delete process.env.OPENWORK_DEV_MODE;
    process.env.ProgramData = programData;
    process.env.PROGRAMDATA = programData;
    process.env.APPDATA = appData;

    const managedPath = path.join(programData, "OpenWork", "desktop-bootstrap.json");
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(
      managedPath,
      JSON.stringify({ baseUrl: "https://den.example.com", apiBaseUrl: "https://den.example.com/api/den", requireSignin: true }),
      "utf8",
    );

    const store = createWorkspaceStore({
      app: { getPath: () => userData },
      defaultDenBaseUrl: "https://app.openworklabs.com",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });

    assert.deepEqual(await store.getDesktopBootstrapConfig(), {
      baseUrl: "https://den.example.com",
      apiBaseUrl: "https://den.example.com/api/den",
      requireSignin: true,
    });
  } finally {
    setEnv("ProgramData", previousProgramData);
    setEnv("PROGRAMDATA", previousProgramdata);
    setEnv("APPDATA", previousAppData);
    setEnv("OPENWORK_DESKTOP_BOOTSTRAP_PATH", previousOverride);
    setEnv("OPENWORK_DEV_MODE", previousDevMode);
  }
});

test("workspace store persists Den remote workspace metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-workspace-store-"));
  const userData = path.join(root, "user-data");
  const store = createWorkspaceStore({
    app: { getPath: () => userData },
    defaultDenBaseUrl: "https://app.openworklabs.com",
    defaultRequireSignin: false,
    forceRequireSignin: false,
  });

  const list = await store.createRemoteWorkspace({
    baseUrl: "http://worker.local:8787",
    openworkHostUrl: "http://worker.local:8787",
    openworkToken: "client-token",
    openworkClientToken: "client-token",
    openworkWorkspaceId: "ws_123",
    openworkWorkspaceName: "workspace",
    openworkDenBaseUrl: "https://den.example.com",
    openworkDenApiBaseUrl: "https://den.example.com/api/den",
    openworkDenOrgId: "org_123",
    openworkDenWorkerId: "wrk_123",
    displayName: "OpenWork workspace",
    remoteType: "openwork",
  });

  assert.equal(list.workspaces.length, 1);
  assert.deepEqual(list.workspaces[0], {
    id: "rem_ws_123",
    name: "OpenWork workspace",
    path: "",
    preset: "remote",
    workspaceType: "remote",
    remoteType: "openwork",
    baseUrl: "http://worker.local:8787",
    directory: null,
    displayName: "OpenWork workspace",
    openworkHostUrl: "http://worker.local:8787",
    openworkToken: "client-token",
    openworkClientToken: "client-token",
    openworkHostToken: null,
    openworkWorkspaceId: "ws_123",
    openworkWorkspaceName: "workspace",
    openworkDenBaseUrl: "https://den.example.com",
    openworkDenApiBaseUrl: "https://den.example.com/api/den",
    openworkDenOrgId: "org_123",
    openworkDenWorkerId: "wrk_123",
    sandboxBackend: null,
    sandboxRunId: null,
    sandboxContainerName: null,
  });

  const raw = await readFile(path.join(userData, "openwork-workspaces.json"), "utf8");
  const persisted = JSON.parse(raw);
  assert.equal(persisted.workspaces[0].baseUrl, "http://worker.local:8787");
  assert.equal(persisted.workspaces[0].openworkDenWorkerId, "wrk_123");
});

function setEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
