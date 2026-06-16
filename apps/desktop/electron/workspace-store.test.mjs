import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

function setEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
