import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildNukeWorkerNukeInput,
  buildNukeWorkerPayload,
  buildNukeManifest,
  executeNukeFreshStart,
  runPendingNukeCleanup,
  sanitizeDesktopBootstrapConfig,
  sanitizeDesktopBootstrapFiles,
  scheduleNukeCleanupWorker,
} from "./nuke.mjs";
import { runNukeCleanupWorker } from "./nuke-worker.mjs";

async function exists(targetPath) {
  try {
    await readFile(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function withTempDir(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-nuke-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function pendingNukeInput(root) {
  return {
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
    homedir: path.join(root, "home"),
    platform: "darwin",
    userDataPath: path.join(root, "userData"),
  };
}

function pendingNukePath(root) {
  return path.join(root, "xdg", "openwork", ".nuke-pending.json");
}

async function writePendingNuke(root, pending) {
  const pendingPath = pendingNukePath(root);
  await mkdir(path.dirname(pendingPath), { recursive: true });
  await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  return pendingPath;
}

async function readJson(targetPath) {
  return JSON.parse(await readFile(targetPath, "utf8"));
}

function fakeSession() {
  const session = {
    clearStorageData: async () => {},
    flushStorageData: () => {},
  };
  return {
    defaultSession: session,
    fromPartition: () => session,
  };
}

function fakeRuntimeManager() {
  return {
    dispose: async () => {},
    prepareFreshRuntime: async () => {},
    sandboxCleanupOpenworkContainers: async () => ({ candidates: [], removed: [], errors: [] }),
  };
}

function fakeUiControlServer() {
  return { stop: async () => {} };
}

function fakeApp(userDataPath) {
  return {
    isPackaged: true,
    relaunchCount: 0,
    quitCount: 0,
    getPath(name) {
      if (name === "userData") return userDataPath;
      throw new Error(`Unexpected app path ${name}`);
    },
    relaunch() {
      this.relaunchCount += 1;
    },
    quit() {
      this.quitCount += 1;
    },
  };
}

async function tinyDelay(ms = 140) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("buildNukeManifest includes default macOS state roots and preserves bootstrap", () => {
  const home = "/Users/alice";
  const userDataPath = "/Users/alice/Library/Application Support/com.differentai.openwork";
  const manifest = buildNukeManifest({ env: {}, homedir: home, platform: "darwin", userDataPath });

  assert.equal(manifest.bootstrapPath, "/Users/alice/.config/openwork/desktop-bootstrap.json");
  assert.equal(manifest.preserveBootstrapPath, "/Users/alice/.config/openwork/desktop-bootstrap.json");
  assert.deepEqual(manifest.partitions, ["default", "persist:openwork-browser"]);
  assert.ok(manifest.deletePaths.includes(userDataPath));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.config/openwork/server.json"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.config/openwork/runtime.sqlite"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.config/openwork/runtime.sqlite-wal"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.config/openwork/runtime.sqlite-shm"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.config/openwork/runtime-opencode-config.json"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.config/openwork/tokens.json"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.config/openwork/env.json"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.local/share/opencode"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/Library/Application Support/opencode"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.config/opencode"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.cache/opencode"));
  assert.ok(manifest.deletePaths.includes("/Users/alice/.openwork/openwork-orchestrator"));
  assert.ok(!manifest.deletePaths.includes("/Users/alice/.opencode/bin"));
  assert.ok(!manifest.deletePaths.includes("/Users/alice/project/.opencode"));
});

test("buildNukeManifest can include the bootstrap file in the wipe", () => {
  const bootstrapPath = "/Users/alice/.config/openwork/desktop-bootstrap.json";
  const manifest = buildNukeManifest({
    env: {},
    homedir: "/Users/alice",
    platform: "darwin",
    preserveBootstrap: false,
    userDataPath: "/Users/alice/Library/Application Support/com.differentai.openwork",
  });

  assert.equal(manifest.bootstrapPath, bootstrapPath);
  assert.equal(manifest.preserveBootstrapPath, null);
  assert.ok(manifest.deletePaths.includes(bootstrapPath));
});

test("buildNukeManifest includes default Linux state roots", () => {
  const manifest = buildNukeManifest({
    env: {},
    homedir: "/home/alice",
    platform: "linux",
    userDataPath: "/home/alice/.config/com.differentai.openwork",
  });

  assert.equal(manifest.preserveBootstrapPath, "/home/alice/.config/openwork/desktop-bootstrap.json");
  assert.ok(manifest.deletePaths.includes("/home/alice/.config/com.differentai.openwork"));
  assert.ok(manifest.deletePaths.includes("/home/alice/.local/share/opencode"));
  assert.ok(manifest.deletePaths.includes("/home/alice/.config/opencode"));
  assert.ok(manifest.deletePaths.includes("/home/alice/.cache/opencode"));
  assert.ok(!manifest.deletePaths.some((targetPath) => targetPath.includes("Library/Application Support/opencode")));
});

test("buildNukeManifest includes Windows path shapes", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
  };
  const manifest = buildNukeManifest({
    env,
    homedir: "C:\\Users\\Alice",
    platform: "win32",
    userDataPath: "C:\\Users\\Alice\\AppData\\Roaming\\com.differentai.openwork",
  });

  assert.equal(manifest.preserveBootstrapPath, "C:\\Users\\Alice\\AppData\\Local\\openwork\\desktop-bootstrap.json");
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\AppData\\Roaming\\com.differentai.openwork"));
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\AppData\\Roaming\\openwork\\server.json"));
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\AppData\\Roaming\\openwork\\runtime.sqlite"));
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\AppData\\Roaming\\openwork\\tokens.json"));
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\AppData\\Roaming\\openwork\\env.json"));
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\AppData\\Roaming\\opencode"));
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\AppData\\Roaming\\opencode"));
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\.cache\\opencode"));
  assert.ok(manifest.deletePaths.includes("C:\\Users\\Alice\\.config\\openwork\\desktop-bootstrap.json"));
});

test("buildNukeManifest honors OPENWORK_ELECTRON_USERDATA override", () => {
  const manifest = buildNukeManifest({
    env: { OPENWORK_ELECTRON_USERDATA: "/tmp/openwork-userdata" },
    homedir: "/Users/alice",
    platform: "darwin",
    userDataPath: "/Users/alice/Library/Application Support/com.differentai.openwork",
  });

  assert.ok(manifest.deletePaths.includes("/tmp/openwork-userdata"));
  assert.ok(!manifest.deletePaths.includes("/Users/alice/Library/Application Support/com.differentai.openwork"));
});

test("buildNukeManifest redirects HOME/XDG paths in dev mode", () => {
  const manifest = buildNukeManifest({
    env: { OPENWORK_DEV_MODE: "1" },
    homedir: "/Users/alice",
    platform: "darwin",
    userDataPath: "/tmp/openwork-dev-userdata",
  });

  assert.equal(
    manifest.preserveBootstrapPath,
    "/tmp/openwork-dev-userdata/openwork-dev-data/home/.config/openwork/desktop-bootstrap.json",
  );
  assert.ok(manifest.deletePaths.includes("/tmp/openwork-dev-userdata"));
  assert.ok(manifest.deletePaths.includes("/tmp/openwork-dev-userdata/openwork-dev-data/xdg/data/opencode"));
  assert.ok(manifest.deletePaths.includes("/tmp/openwork-dev-userdata/openwork-dev-data/config/opencode"));
  assert.ok(manifest.deletePaths.includes("/tmp/openwork-dev-userdata/openwork-dev-data/xdg/cache/opencode"));
  assert.ok(!manifest.deletePaths.some((targetPath) => targetPath.startsWith("/Users/alice/")));
});

test("buildNukeManifest excludes paths that would remove ~/.opencode/bin", () => {
  const manifest = buildNukeManifest({
    env: { OPENCODE_CONFIG_DIR: "/Users/alice/.opencode" },
    homedir: "/Users/alice",
    platform: "darwin",
    userDataPath: "/tmp/openwork-userdata",
  });

  assert.ok(!manifest.deletePaths.includes("/Users/alice/.opencode"));
  assert.ok(!manifest.deletePaths.includes("/Users/alice/.opencode/bin"));
});

test("sanitizeDesktopBootstrapConfig strips secrets and keeps deployment fields", () => {
  const writtenAt = "2026-07-20T00:00:00.000Z";
  const sanitized = sanitizeDesktopBootstrapConfig({
    baseUrl: " https://den.example.com ",
    apiBaseUrl: " https://api.den.example.com ",
    requireSignin: true,
    brandAppName: " Acme OpenWork ",
    brandLogoUrl: " https://cdn.example.com/logo.png ",
    brandIconUrl: " https://cdn.example.com/icon.png ",
    handoff: { grant: "secret", denBaseUrl: "https://den.example.com" },
    claimLinks: [{ id: "claim", role: "admin", token: "secret", url: "https://den.example.com", expiresAt: writtenAt }],
    prepared: { skillPath: "/tmp/skill" },
  }, writtenAt);

  assert.deepEqual(sanitized, {
    baseUrl: "https://den.example.com",
    apiBaseUrl: "https://api.den.example.com",
    requireSignin: true,
    brandAppName: "Acme OpenWork",
    brandLogoUrl: "https://cdn.example.com/logo.png",
    brandIconUrl: "https://cdn.example.com/icon.png",
    writtenAt,
  });
});

test("sanitizeDesktopBootstrapFiles strips a BOM-wrapped valid canonical bootstrap", async () => {
  await withTempDir(async (root) => {
    const canonicalPath = path.join(root, "desktop-bootstrap.json");
    await writeFile(canonicalPath, `\ufeff${JSON.stringify({
      baseUrl: "https://den.example.com",
      requireSignin: true,
      handoff: { grant: "secret-grant" },
      claimLinks: [{ token: "secret-token" }],
      prepared: { skillPath: "/tmp/skill" },
    })}`, "utf8");

    assert.equal(await sanitizeDesktopBootstrapFiles({ canonicalPath, legacyPath: null }), true);
    const raw = await readFile(canonicalPath, "utf8");
    const parsed = JSON.parse(raw);

    assert.notEqual(raw.charCodeAt(0), 0xfeff);
    assert.equal(parsed.baseUrl, "https://den.example.com");
    assert.equal(parsed.requireSignin, true);
    assert.equal(parsed.handoff, undefined);
    assert.equal(parsed.claimLinks, undefined);
    assert.equal(parsed.prepared, undefined);
  });
});

test("sanitizeDesktopBootstrapFiles deletes truly malformed bootstrap files", async () => {
  await withTempDir(async (root) => {
    const canonicalPath = path.join(root, "desktop-bootstrap.json");
    await writeFile(canonicalPath, "{not-json secret-grant secret-token", "utf8");

    assert.equal(await sanitizeDesktopBootstrapFiles({ canonicalPath, legacyPath: null }), false);
    assert.equal(await exists(canonicalPath), false);
  });
});

test("sanitizeDesktopBootstrapFiles falls back from invalid canonical to valid legacy", async () => {
  await withTempDir(async (root) => {
    const canonicalPath = path.join(root, "canonical", "desktop-bootstrap.json");
    const legacyPath = path.join(root, "legacy", "desktop-bootstrap.json");
    await mkdir(path.dirname(canonicalPath), { recursive: true });
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(canonicalPath, "{not-json secret-grant", "utf8");
    await writeFile(legacyPath, JSON.stringify({
      baseUrl: "https://legacy.example.com",
      requireSignin: true,
      brandAppName: "Legacy Org",
      handoff: { grant: "legacy-secret-grant" },
      claimLinks: [{ token: "legacy-secret-token" }],
    }), "utf8");

    assert.equal(await sanitizeDesktopBootstrapFiles({ canonicalPath, legacyPath }), true);
    const raw = await readFile(canonicalPath, "utf8");
    const parsed = JSON.parse(raw);

    assert.equal(parsed.baseUrl, "https://legacy.example.com");
    assert.equal(parsed.brandAppName, "Legacy Org");
    assert.equal(parsed.handoff, undefined);
    assert.equal(parsed.claimLinks, undefined);
    assert.equal(raw.includes("legacy-secret"), false);
    assert.equal(await exists(legacyPath), false);
  });
});

test("runPendingNukeCleanup removes the sentinel after all pending paths are gone", async () => {
  await withTempDir(async (root) => {
    const targetPath = path.join(root, "locked-runtime.sqlite");
    await writeFile(targetPath, "delete me", "utf8");
    const pendingPath = await writePendingNuke(root, {
      paths: [targetPath],
      createdAt: "2026-07-20T00:00:00.000Z",
    });

    const result = await runPendingNukeCleanup(pendingNukeInput(root));

    assert.equal(result.ran, true);
    assert.deepEqual(result.pendingRetry, []);
    assert.deepEqual(result.errors, []);
    assert.ok(result.deleted.includes(targetPath));
    assert.equal(await exists(targetPath), false);
    assert.equal(await exists(pendingPath), false);
  });
});

test("runPendingNukeCleanup retains the choice to remove bootstrap state", async () => {
  await withTempDir(async (root) => {
    const input = pendingNukeInput(root);
    const bootstrapPath = path.join(input.env.XDG_CONFIG_HOME, "openwork", "desktop-bootstrap.json");
    await mkdir(path.dirname(bootstrapPath), { recursive: true });
    await writeFile(bootstrapPath, JSON.stringify({ baseUrl: "https://den.example.com" }), "utf8");
    await writePendingNuke(root, {
      paths: [bootstrapPath],
      preserveBootstrap: false,
    });

    const result = await runPendingNukeCleanup(input);

    assert.equal(result.ran, true);
    assert.equal(await exists(bootstrapPath), false);
  });
});

test("runPendingNukeCleanup rewrites only failed paths and removes them on the next boot", async () => {
  await withTempDir(async (root) => {
    const okPath = path.join(root, "ok-runtime.sqlite");
    const failedPath = path.join(root, "locked-runtime.sqlite");
    await writeFile(okPath, "delete me", "utf8");
    await writeFile(failedPath, "locked", "utf8");
    const createdAt = "2026-07-20T00:00:00.000Z";
    const attemptedAt = "2026-07-21T00:00:00.000Z";
    const pendingPath = await writePendingNuke(root, { paths: [okPath, failedPath], createdAt });

    const firstResult = await runPendingNukeCleanup(pendingNukeInput(root), {
      nowIso: attemptedAt,
      removePathWithRetry: async (targetPath) => {
        if (targetPath === failedPath) return new Error("simulated lock");
        await rm(targetPath, { recursive: true, force: true });
        return null;
      },
    });
    const rewritten = await readJson(pendingPath);

    assert.equal(firstResult.ran, true);
    assert.deepEqual(firstResult.pendingRetry, [failedPath]);
    assert.ok(firstResult.deleted.includes(okPath));
    assert.equal(firstResult.errors.length, 1);
    assert.equal(firstResult.errors[0].path, failedPath);
    assert.equal(await exists(okPath), false);
    assert.equal(await exists(failedPath), true);
    assert.deepEqual(rewritten.paths, [failedPath]);
    assert.equal(rewritten.createdAt, createdAt);
    assert.equal(rewritten.attemptedAt, attemptedAt);

    const secondResult = await runPendingNukeCleanup(pendingNukeInput(root));

    assert.equal(secondResult.ran, true);
    assert.deepEqual(secondResult.pendingRetry, []);
    assert.deepEqual(secondResult.errors, []);
    assert.ok(secondResult.deleted.includes(failedPath));
    assert.equal(await exists(failedPath), false);
    assert.equal(await exists(pendingPath), false);
  });
});

test("runPendingNukeCleanup removes invalid or empty sentinels without looping", async () => {
  await withTempDir(async (root) => {
    const invalidPendingPath = pendingNukePath(root);
    await mkdir(path.dirname(invalidPendingPath), { recursive: true });
    await writeFile(invalidPendingPath, "{not-json", "utf8");

    const invalidResult = await runPendingNukeCleanup(pendingNukeInput(root));

    assert.equal(invalidResult.ran, false);
    assert.equal(invalidResult.invalid, true);
    assert.equal(await exists(invalidPendingPath), false);

    const emptyPendingPath = await writePendingNuke(root, { paths: [] });
    const emptyResult = await runPendingNukeCleanup(pendingNukeInput(root));

    assert.equal(emptyResult.ran, false);
    assert.equal(emptyResult.invalid, false);
    assert.equal(await exists(emptyPendingPath), false);
  });
});

test("nuke worker payload only serializes safe path inputs", () => {
  const nukeInput = buildNukeWorkerNukeInput({
    env: {
      APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
      OPENWORK_API_KEY: "secret-api-key",
      OPENWORK_TOKEN: "secret-token",
      OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: "9888",
      OPENWORK_TOKEN_STORE: "C:\\Users\\Alice\\AppData\\Roaming\\openwork\\tokens.json",
      XDG_CONFIG_HOME: "/tmp/config",
    },
    homedir: "/tmp/home",
    platform: "darwin",
    userDataPath: "/tmp/userData",
    preserveBootstrap: false,
  });
  const payload = buildNukeWorkerPayload({
    parentPid: 123,
    nukeInput,
    appExecutablePath: process.execPath,
    appArgv: ["--remote-debugging-port=9888", "--remote-debugging-address=0.0.0.0", "--secret=token"],
    pendingPath: "/tmp/config/openwork/.nuke-pending.json",
    nowMs: 1_000,
  });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.nukeInput.env.APPDATA, "C:\\Users\\Alice\\AppData\\Roaming");
  assert.equal(payload.nukeInput.env.XDG_CONFIG_HOME, "/tmp/config");
  assert.equal(payload.nukeInput.env.OPENWORK_TOKEN_STORE, "C:\\Users\\Alice\\AppData\\Roaming\\openwork\\tokens.json");
  assert.equal(payload.nukeInput.preserveBootstrap, false);
  assert.deepEqual(payload.appArgv, []);
  assert.equal(serialized.includes("secret-api-key"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("--secret"), false);
  assert.equal(serialized.includes("0.0.0.0"), false);
  assert.equal(serialized.includes("9888"), false);
  assert.equal(serialized.includes("OPENWORK_ELECTRON_REMOTE_DEBUG_PORT"), false);
  assert.equal(serialized.includes("OPENWORK_API_KEY"), false);
  assert.equal(serialized.includes("OPENWORK_TOKEN\""), false);

  const devPayload = buildNukeWorkerPayload({
    parentPid: 123,
    nukeInput,
    appExecutablePath: process.execPath,
    appArgv: ["/repo/apps/desktop/electron/main.mjs", "--remote-debugging-port=9888"],
    pendingPath: "/tmp/config/openwork/.nuke-pending.json",
    nowMs: 1_000,
  });
  assert.deepEqual(devPayload.appArgv, ["/repo/apps/desktop/electron/main.mjs"]);
});

test("scheduleNukeCleanupWorker launches Electron as Node with a detached safe payload", async () => {
  await withTempDir(async (root) => {
    const input = pendingNukeInput(root);
    input.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT = "9888";
    const plan = {
      pendingPath: pendingNukePath(root),
    };
    const app = fakeApp(input.userDataPath);
    let spawnCommand = "";
    let spawnArgs = [];
    let spawnOptions = { detached: false, env: {}, shell: "unset", stdio: "" };
    let unrefCalled = false;

    const result = await scheduleNukeCleanupWorker({
      app,
      input,
      plan,
      execPath: process.execPath,
      argv: [process.execPath, "--remote-debugging-port=9888", "--remote-debugging-address=0.0.0.0", "--ignored"],
      env: { SECRET_TOKEN: "do-not-write", XDG_CONFIG_HOME: input.env.XDG_CONFIG_HOME, OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: "9888" },
      spawnFn: (command, args, options) => {
        spawnCommand = command;
        spawnArgs = args;
        spawnOptions = options;
        return { pid: 9876, unref: () => { unrefCalled = true; } };
      },
    });
    const payload = await readJson(result.payloadPath);

    assert.equal(result.pid, 9876);
    assert.equal(unrefCalled, true);
    assert.equal(spawnCommand, process.execPath);
    assert.ok(spawnArgs[0].endsWith("nuke-worker.mjs"));
    assert.equal(spawnArgs[1], result.payloadPath);
    assert.equal(spawnOptions.detached, true);
    assert.equal(spawnOptions.stdio, "ignore");
    assert.equal(spawnOptions.shell, undefined);
    assert.equal(spawnOptions.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(spawnOptions.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT, undefined);
    assert.equal(payload.nukeInput.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT, undefined);
    assert.deepEqual(payload.appArgv, []);
    assert.equal(JSON.stringify(payload).includes("do-not-write"), false);

    await rm(result.payloadPath, { force: true });
  });
});

test("nuke cleanup worker waits for parent exit, clears pending path, removes payload, and launches app", async () => {
  await withTempDir(async (root) => {
    const targetPath = path.join(root, "userData");
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, "marker.txt"), "delete me", "utf8");
    const pendingPath = await writePendingNuke(root, {
      paths: [targetPath],
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 180)"], { stdio: "ignore" });
    const payloadPath = path.join(root, "payload.json");
    const payload = buildNukeWorkerPayload({
      parentPid: parent.pid,
      nukeInput: pendingNukeInput(root),
      appExecutablePath: process.execPath,
      appArgv: ["--remote-debugging-port=9888"],
      pendingPath,
      nowMs: Date.now(),
    });
    payload.parentWaitDeadlineAt = Date.now() + 4000;
    payload.deadlineAt = Date.now() + 6000;
    await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    let launchedAfterParentExit = false;
    let launchedArgs = null;
    let launchEnv = {};

    const result = await runNukeCleanupWorker(payloadPath, {
      env: { ELECTRON_RUN_AS_NODE: "1", OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: "9888" },
      relaunchHandleGraceMs: 0,
      spawnApp: (_command, args, options) => {
        launchedAfterParentExit = parent.exitCode !== null;
        launchedArgs = args;
        launchEnv = options.env;
        return { pid: 4321, unref: () => {} };
      },
    });

    assert.equal(result.launchPid, 4321);
    assert.equal(launchedAfterParentExit, true);
    assert.deepEqual(launchedArgs, []);
    assert.equal(launchEnv.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(launchEnv.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT, undefined);
    assert.equal(await exists(targetPath), false);
    assert.equal(await exists(pendingPath), false);
    assert.equal(await exists(payloadPath), false);
    parent.kill();
  });
});

test("nuke cleanup worker still removes payload and launches app when cleanup throws", async () => {
  await withTempDir(async (root) => {
    const payloadPath = path.join(root, "payload.json");
    const payload = buildNukeWorkerPayload({
      parentPid: 0,
      nukeInput: pendingNukeInput(root),
      appExecutablePath: process.execPath,
      appArgv: [],
      pendingPath: pendingNukePath(root),
      nowMs: Date.now(),
    });
    await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    let launched = false;

    const result = await runNukeCleanupWorker(payloadPath, {
      relaunchHandleGraceMs: 0,
      runPendingCleanup: async () => {
        throw new Error("cleanup failed");
      },
      spawnApp: () => {
        launched = true;
        return { pid: 5432, unref: () => {} };
      },
    });

    assert.equal(result.launchPid, 5432);
    assert.equal(launched, true);
    assert.equal(result.cleanup.errors[0].message, "cleanup failed");
    assert.equal(await exists(payloadPath), false);
  });
});

test("executeNukeFreshStart falls back to direct relaunch when worker spawn fails", async () => {
  await withTempDir(async (root) => {
    const input = pendingNukeInput(root);
    await mkdir(input.userDataPath, { recursive: true });
    const app = fakeApp(input.userDataPath);

    const receipt = await executeNukeFreshStart({
      app,
      session: fakeSession(),
      runtimeManager: fakeRuntimeManager(),
      uiControlServer: fakeUiControlServer(),
      removeWindowsBrandShortcut: async () => {},
    }, {
      input,
      removePathWithRetry: async (targetPath) => {
        if (targetPath === input.userDataPath) return new Error("simulated Chromium lock");
        await rm(targetPath, { recursive: true, force: true });
        return null;
      },
      scheduleCleanupWorker: async () => {
        throw new Error("spawn failed");
      },
    });

    assert.equal(receipt.relaunchMode, "direct");
    assert.equal(receipt.workerScheduled, false);
    assert.ok(receipt.pendingRetry.includes(input.userDataPath));
    assert.ok(receipt.errors.some((error) => error.path === "nuke-cleanup-worker" && error.message === "spawn failed"));
    assert.equal(await exists(pendingNukePath(root)), true);
    await tinyDelay();
    assert.equal(app.relaunchCount, 1);
    assert.equal(app.quitCount, 1);
  });
});

test("executeNukeFreshStart schedules cleanup worker for pending paths", async () => {
  await withTempDir(async (root) => {
    const input = pendingNukeInput(root);
    await mkdir(input.userDataPath, { recursive: true });
    const app = fakeApp(input.userDataPath);
    let scheduled = false;

    const receipt = await executeNukeFreshStart({
      app,
      session: fakeSession(),
      runtimeManager: fakeRuntimeManager(),
      uiControlServer: fakeUiControlServer(),
      removeWindowsBrandShortcut: async () => {},
    }, {
      input,
      removePathWithRetry: async (targetPath) => {
        if (targetPath === input.userDataPath) return new Error("simulated Chromium lock");
        await rm(targetPath, { recursive: true, force: true });
        return null;
      },
      scheduleCleanupWorker: async () => {
        scheduled = true;
        return { pid: 1234, payloadPath: path.join(root, "payload.json") };
      },
    });

    assert.equal(receipt.relaunchMode, "cleanup_worker");
    assert.equal(receipt.workerScheduled, true);
    assert.equal(scheduled, true);
    assert.ok(receipt.pendingRetry.includes(input.userDataPath));
    assert.equal(await exists(pendingNukePath(root)), true);
    await tinyDelay();
    assert.equal(app.relaunchCount, 0);
    assert.equal(app.quitCount, 1);
  });
});

test("executeNukeFreshStart relaunches directly when no paths remain pending", async () => {
  await withTempDir(async (root) => {
    const input = pendingNukeInput(root);
    await mkdir(input.userDataPath, { recursive: true });
    const app = fakeApp(input.userDataPath);

    const receipt = await executeNukeFreshStart({
      app,
      session: fakeSession(),
      runtimeManager: fakeRuntimeManager(),
      uiControlServer: fakeUiControlServer(),
      removeWindowsBrandShortcut: async () => {},
    }, { input });

    assert.equal(receipt.relaunchMode, "direct");
    assert.equal(receipt.workerScheduled, false);
    assert.deepEqual(receipt.pendingRetry, []);
    await tinyDelay();
    assert.equal(app.relaunchCount, 1);
    assert.equal(app.quitCount, 1);
  });
});

test("executeNukeFreshStart removes the bootstrap when preservation is disabled", async () => {
  await withTempDir(async (root) => {
    const input = { ...pendingNukeInput(root), preserveBootstrap: false };
    const bootstrapPath = path.join(input.env.XDG_CONFIG_HOME, "openwork", "desktop-bootstrap.json");
    await mkdir(path.dirname(bootstrapPath), { recursive: true });
    await writeFile(bootstrapPath, JSON.stringify({ baseUrl: "https://den.example.com" }), "utf8");
    await mkdir(input.userDataPath, { recursive: true });
    const app = fakeApp(input.userDataPath);

    const receipt = await executeNukeFreshStart({
      app,
      session: fakeSession(),
      runtimeManager: fakeRuntimeManager(),
      uiControlServer: fakeUiControlServer(),
      removeWindowsBrandShortcut: async () => {},
    }, { input });

    assert.equal(receipt.preservedBootstrap, false);
    assert.equal(await exists(bootstrapPath), false);
    await tinyDelay();
  });
});
