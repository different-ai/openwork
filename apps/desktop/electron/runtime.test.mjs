import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  commandMatchesPackagedSidecar,
  prioritizeWorkspacePaths,
  resolveOpenworkServerConfigPath,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyOpenworkPortWorkspace,
} from "./runtime.mjs";

describe("prioritizeWorkspacePaths", () => {
  it("keeps the active runtime workspace first", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current", ["/workspace/other", "/workspace/current"]),
      ["/workspace/current", "/workspace/other"],
    );
  });

  it("dedupes equivalent paths", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current/../current", ["/workspace/current"]),
      ["/workspace/current/../current"],
    );
  });
});

describe("seedWorkspacePathsForEmbeddedServer", () => {
  it("uses persisted server config instead of Electron workspace state once config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/legacy"], true),
      [],
    );
  });

  it("seeds from Electron workspace state before server config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/first"], false),
      ["/workspace/first"],
    );
  });
});

describe("selectStickyOpenworkPortWorkspace", () => {
  it("uses the requested workspace even when server config owns workspace loading", () => {
    assert.equal(
      selectStickyOpenworkPortWorkspace(["/workspace/current"], []),
      "/workspace/current",
    );
  });

  it("falls back to server workspace paths when no requested path is available", () => {
    assert.equal(
      selectStickyOpenworkPortWorkspace([], ["/workspace/from-server"]),
      "/workspace/from-server",
    );
  });
});

describe("commandMatchesPackagedSidecar", () => {
  it("matches packaged opencode sidecars with platform suffixes", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode-aarch64-apple-darwin serve --hostname 127.0.0.1 --port 49174 --cors *",
        ["/Applications/OpenWork.app/Contents/Resources/sidecars"],
      ),
      true,
    );
  });

  it("does not match unrelated opencode processes outside sidecar directories", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 49174",
        ["/Applications/OpenWork.app/Contents/Resources/sidecars"],
      ),
      false,
    );
  });
});

describe("resolveOpenworkServerConfigPath", () => {
  it("respects explicit server config path", () => {
    assert.equal(
      resolveOpenworkServerConfigPath({ OPENWORK_SERVER_CONFIG: "/tmp/openwork/server.json" }),
      "/tmp/openwork/server.json",
    );
  });

  it("uses XDG config home on Unix", () => {
    if (process.platform === "win32") return;
    assert.equal(
      resolveOpenworkServerConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }),
      "/tmp/xdg/openwork/server.json",
    );
  });
});
