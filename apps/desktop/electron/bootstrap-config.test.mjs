import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  desktopBootstrapCandidates,
  filterWorkspacesForManagedDen,
  managedDesktopBootstrapPath,
  normalizeDesktopBootstrapConfig,
} from "./bootstrap-config.mjs";

test("desktop bootstrap candidates use env, managed, user/dev, then defaults", () => {
  const env = {
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: "D:\\managed\\override.json",
    ProgramData: "C:\\ProgramData",
    APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
  };

  const candidates = desktopBootstrapCandidates({
    env,
    platform: "win32",
    homedir: "C:\\Users\\Alice",
  });

  assert.deepEqual(candidates.map((candidate) => candidate.source), [
    "env",
    "managed",
    "user",
    "user-dev",
  ]);
  assert.equal(candidates[0].path, env.OPENWORK_DESKTOP_BOOTSTRAP_PATH);
  assert.equal(candidates[1].path, path.join("C:\\ProgramData", "OpenWork", "desktop-bootstrap.json"));
  assert.equal(candidates[2].path, path.join("C:\\Users\\Alice\\AppData\\Roaming", "openwork", "desktop-bootstrap.json"));
  assert.equal(candidates[3].path, path.join("C:\\Users\\Alice", ".config", "openwork", "desktop-bootstrap.json"));
});

test("windows managed bootstrap defaults to ProgramData without env override", () => {
  assert.equal(
    managedDesktopBootstrapPath({ env: {}, platform: "win32" }),
    path.join("C:\\ProgramData", "OpenWork", "desktop-bootstrap.json"),
  );
});

test("normalize desktop bootstrap honors forced sign-in env", () => {
  assert.deepEqual(
    normalizeDesktopBootstrapConfig(
      { baseUrl: " http://den.local:3005 ", apiBaseUrl: "", requireSignin: false },
      { env: { OPENWORK_FORCE_SIGNIN: "true" } },
    ),
    { baseUrl: "http://den.local:3005", apiBaseUrl: null, requireSignin: true },
  );
});

test("managed Den filtering rejects ambiguous legacy remote OpenWork workspaces", () => {
  const workspaces = [
    { id: "local", workspaceType: "local" },
    { id: "legacy", workspaceType: "remote", remoteType: "openwork", openworkHostUrl: "http://old-worker:8787" },
    { id: "wrong-den", workspaceType: "remote", remoteType: "openwork", openworkDenBaseUrl: "http://old-den:3005" },
    { id: "current-den", workspaceType: "remote", remoteType: "openwork", openworkDenBaseUrl: "http://den.company.local:3005/api/den" },
    { id: "other-remote", workspaceType: "remote", remoteType: "opencode" },
  ];

  assert.deepEqual(
    filterWorkspacesForManagedDen(workspaces, "http://den.company.local:3005").map((workspace) => workspace.id),
    ["local", "current-den", "other-remote"],
  );
});
