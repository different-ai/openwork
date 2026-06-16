import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceStore } from "./workspace-store.mjs";

test("workspace store reads managed desktop bootstrap before user fallback", async () => {
  const previousProgramData = process.env.ProgramData;
  const previousProgramdata = process.env.PROGRAMDATA;
  const previousAppData = process.env.APPDATA;
  const previousOverride = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  const previousDevMode = process.env.OPENWORK_DEV_MODE;
  const root = await mkdtemp(path.join(os.tmpdir(), "openwork-workspace-store-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "openwork-workspace-store-"));
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
