import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commandMatchesPackagedSidecar,
  embeddedServerImportUrl,
  prioritizeWorkspacePaths,
  resetRuntimeStatesAfterFailedServerStart,
  resolveEngineRolloverPreference,
  resolveEvalLocalServerDelayMs,
  resolveOpenworkServerConfigPath,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyOpenworkPortWorkspace,
  snapshotEngineState,
  snapshotOpenworkServerState,
} from "./runtime.mjs";

describe("engine rollover preference", () => {
  it("uses an explicit value and otherwise restores the persisted value", () => {
    assert.equal(resolveEngineRolloverPreference(true, false), true);
    assert.equal(resolveEngineRolloverPreference(false, true), false);
    assert.equal(resolveEngineRolloverPreference(undefined, true), true);
    assert.equal(resolveEngineRolloverPreference(undefined, false), false);
  });

  it("reports the active mode in the desktop server snapshot", () => {
    const snapshot = snapshotOpenworkServerState({
      child: null,
      childExited: true,
      inProcess: true,
      engineRollover: true,
    });
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.engineRollover, true);
  });
});

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

describe("resolveEvalLocalServerDelayMs", () => {
  it("enables only positive finite eval delays", () => {
    assert.equal(resolveEvalLocalServerDelayMs({ OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS: "3000" }), 3000);
    assert.equal(resolveEvalLocalServerDelayMs({ OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS: "0" }), 0);
    assert.equal(resolveEvalLocalServerDelayMs({ OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS: "-1" }), 0);
    assert.equal(resolveEvalLocalServerDelayMs({ OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS: "Infinity" }), 0);
    assert.equal(resolveEvalLocalServerDelayMs({ OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS: "invalid" }), 0);
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

describe("embeddedServerImportUrl", () => {
  it("returns the same file URL for unchanged metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");

      const first = embeddedServerImportUrl(embeddedPath);
      const second = embeddedServerImportUrl(embeddedPath);
      const url = new URL(first);

      assert.equal(first, second);
      assert.equal(url.protocol, "file:");
      assert.equal(fileURLToPath(url), embeddedPath);
      assert.ok(url.searchParams.get("mtimeMs"));
      assert.equal(url.searchParams.get("size"), String("export const value = 1;\n".length));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes when the file metadata changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");
      const first = embeddedServerImportUrl(embeddedPath);

      await writeFile(embeddedPath, "export const value = 12;\n");

      assert.notEqual(embeddedServerImportUrl(embeddedPath), first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the plain file URL if stat fails", () => {
    const missingPath = path.join(os.tmpdir(), "openwork-missing-embedded.js");

    assert.equal(embeddedServerImportUrl(missingPath), pathToFileURL(missingPath).href);
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

describe("snapshotEngineState", () => {
  it("reports server-managed OpenCode liveness and pid without a child handle", () => {
    const snapshot = snapshotEngineState({
      child: null,
      childExited: false,
      runtime: "direct",
      projectDir: "/workspace/current",
      hostname: "127.0.0.1",
      port: 4097,
      baseUrl: "http://127.0.0.1:4097",
      opencodeUsername: null,
      opencodePassword: null,
      opencodeBinPath: null,
      opencodeBinSource: null,
      managedByServer: true,
      managedPid: 12345,
      managedIsAlive: () => true,
      lastStdout: null,
      lastStderr: null,
      execution: null,
    });
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.managedByServer, true);
    assert.equal(snapshot.pid, 12345);
  });
});

describe("resetRuntimeStatesAfterFailedServerStart", () => {
  function staleServerState() {
    return {
      child: null,
      childExited: true,
      inProcess: true,
      remoteAccessEnabled: true,
      host: "127.0.0.1",
      port: 4141,
      baseUrl: "http://127.0.0.1:4141",
      connectUrl: null,
      mdnsUrl: null,
      lanUrl: null,
      clientToken: "client-token",
      ownerToken: "owner-token",
      hostToken: "host-token",
      managedOpencodeBinPath: "/usr/local/bin/opencode",
      managedOpencodeBinSource: "known-location",
      lastStdout: "server stdout",
      lastStderr: "server stderr",
      managedOpencodeExecution: { command: "opencode" },
    };
  }

  function staleEngineState() {
    return {
      child: null,
      childExited: false,
      runtime: "direct",
      projectDir: "/workspace/current",
      hostname: "127.0.0.1",
      port: 4097,
      baseUrl: "http://127.0.0.1:4097",
      opencodeUsername: "user",
      opencodePassword: "pass",
      opencodeBinPath: "/usr/local/bin/opencode",
      opencodeBinSource: "known-location",
      managedByServer: true,
      managedPid: 12345,
      managedIsAlive: () => true,
      lastStdout: "engine stdout",
      lastStderr: "engine stderr",
      execution: { command: "opencode" },
    };
  }

  it("clears a dead managed runtime so snapshots cannot report it running", () => {
    const serverState = staleServerState();
    const engineState = staleEngineState();

    resetRuntimeStatesAfterFailedServerStart(serverState, engineState, { manageOpencode: true });

    assert.equal(serverState.inProcess, false);
    assert.equal(serverState.port, null);
    assert.equal(serverState.baseUrl, null);
    assert.equal(serverState.ownerToken, null);
    // Diagnostics survive the reset.
    assert.equal(serverState.lastStdout, "server stdout");
    assert.equal(serverState.lastStderr, "server stderr");

    assert.equal(engineState.baseUrl, null);
    assert.equal(engineState.managedByServer, false);
    assert.equal(engineState.managedPid, null);
    assert.equal(snapshotEngineState(engineState).running, false);
    // A retry via engineRestart still knows its workspace.
    assert.equal(engineState.projectDir, "/workspace/current");
    assert.equal(engineState.lastStderr, "engine stderr");
  });

  it("leaves an external engine untouched when the failed start did not manage it", () => {
    const serverState = staleServerState();
    const engineState = staleEngineState();
    engineState.managedByServer = false;

    resetRuntimeStatesAfterFailedServerStart(serverState, engineState, { manageOpencode: false });

    assert.equal(serverState.inProcess, false);
    assert.equal(engineState.baseUrl, "http://127.0.0.1:4097");
    assert.equal(engineState.projectDir, "/workspace/current");
  });
});
