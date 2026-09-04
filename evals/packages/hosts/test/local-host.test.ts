import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { allocateFreePort } from "@openwork/cdp";
import { electronProfilePaths, electronSurfaceEnv, freePort, pruneStaleSurfaceProfiles, registerLiveProfileRoot, resolveChromeBinary, stopOwnedElectronSurface, unregisterLiveProfileRoot } from "../src/local.ts";

const ENV_KEYS = [
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "OPENCODE_CONFIG_DIR",
  "OPENWORK_DATA_DIR",
  "OPENWORK_DESKTOP_BOOTSTRAP_PATH",
  "OPENWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY",
  "OPENWORK_DEV_MODE",
  "OPENWORK_ELECTRON_APP_IDENTIFIER",
  "OPENWORK_ELECTRON_APP_NAME",
  "OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION",
  "OPENWORK_ELECTRON_REMOTE_DEBUG_PORT",
  "OPENWORK_ELECTRON_SKIP_SHARED_PREPARE",
  "OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN",
  "OPENWORK_ELECTRON_USERDATA",
  "OPENWORK_ENV_STORE",
  "PORT",
  "VITE_DISABLE_OPENWORK_MODELS",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
].sort();

test("electronProfilePaths returns all expected paths under the profile root", () => {
  const root = join(tmpdir(), "openwork-local-host-profile");
  const paths = electronProfilePaths(root);

  assert.deepEqual(Object.keys(paths).sort(), [
    "appDataDir",
    "bootstrapPath",
    "cacheHome",
    "configHome",
    "dataDir",
    "dataHome",
    "envStorePath",
    "homeDir",
    "localAppDataDir",
    "opencodeConfigDir",
    "root",
    "stateHome",
    "userDataDir",
  ].sort());
  for (const value of Object.values(paths)) {
    assert(value === root || value.startsWith(`${root}/`), `${value} should be under ${root}`);
  }
  assert.equal(paths.userDataDir, join(root, "electron-userdata"));
  assert.equal(paths.bootstrapPath, join(root, "bootstrap.json"));
});

test("electronSurfaceEnv matches the isolated Electron demo contract", () => {
  const root = join(tmpdir(), "openwork-local-host-env");
  const paths = electronProfilePaths(root);
  const env = electronSurfaceEnv(paths, {
    appName: "OpenWork Eval probe",
    appIdentifier: "com.differentai.openwork.eval.probe",
    port: 5123,
    cdpPort: 9123,
  });

  assert.deepEqual(Object.keys(env).filter((key) => key !== "PNPM_HOME").sort(), ENV_KEYS);
  // The one deliberate hole in the isolation: pnpm's version redirection must
  // stay warm, or every spawn re-downloads the pinned pnpm from the network.
  if (process.platform === "darwin" || process.platform === "linux") {
    assert(env.PNPM_HOME, "PNPM_HOME should point at the host's pnpm home");
    assert(!env.PNPM_HOME.startsWith(root), "PNPM_HOME must not be inside the isolated profile");
  }
  assert.equal(env.APPDATA, paths.appDataDir);
  assert.equal(env.HOME, paths.homeDir);
  assert.equal(env.LOCALAPPDATA, paths.localAppDataDir);
  assert.equal(env.OPENWORK_DATA_DIR, paths.dataDir);
  assert.equal(env.OPENWORK_DESKTOP_BOOTSTRAP_PATH, paths.bootstrapPath);
  assert.equal(env.OPENWORK_ENV_STORE, paths.envStorePath);
  assert.equal(env.OPENCODE_CONFIG_DIR, paths.opencodeConfigDir);
  assert.equal(env.OPENWORK_ELECTRON_USERDATA, paths.userDataDir);
  assert.equal(env.PORT, "5123");
  assert.equal(env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT, "9123");
  assert.equal(env.OPENWORK_ELECTRON_APP_NAME, "OpenWork Eval probe");
  assert.equal(env.OPENWORK_ELECTRON_APP_IDENTIFIER, "com.differentai.openwork.eval.probe");
  assert.equal(env.OPENWORK_ELECTRON_SKIP_SHARED_PREPARE, "1");
  assert.equal(env.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN, "1");
  assert.equal(env.XDG_CACHE_HOME, paths.cacheHome);
  assert.equal(env.XDG_CONFIG_HOME, paths.configHome);
  assert.equal(env.XDG_DATA_HOME, paths.dataHome);
  assert.equal(env.XDG_STATE_HOME, paths.stateHome);
});

test("electronSurfaceEnv maps the v2 eval lane before caller overrides", () => {
  const previous = process.env.OPENWORK_EVAL_ENGINE;
  process.env.OPENWORK_EVAL_ENGINE = "V2";
  try {
    const paths = electronProfilePaths(join(tmpdir(), "openwork-local-host-v2-env"));
    const options = {
      appName: "OpenWork Eval v2",
      appIdentifier: "com.differentai.openwork.eval.v2",
      port: 5124,
      cdpPort: 9124,
    };
    assert.equal(electronSurfaceEnv(paths, options).OPENWORK_ENGINE_V2_PREVIEW, "1");
    assert.equal(
      electronSurfaceEnv(paths, options, { OPENWORK_ENGINE_V2_PREVIEW: "sidecar" }).OPENWORK_ENGINE_V2_PREVIEW,
      "sidecar",
    );
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_EVAL_ENGINE;
    else process.env.OPENWORK_EVAL_ENGINE = previous;
  }
});

test("stopOwnedElectronSurface verifies profile ownership before removing it", async () => {
  const profileDir = await mkdtemp(join(tmpdir(), "openwork-owned-electron-"));
  const userDataDir = join(profileDir, "electron-userdata");
  await mkdir(userDataDir, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    env: { ...process.env, OPENWORK_ELECTRON_USERDATA: userDataDir },
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error("Owned Electron fixture did not start.");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await stopOwnedElectronSurface(child.pid, profileDir);
  await assert.rejects(access(profileDir));
});

test("resolveChromeBinary honors CHROME_BIN before platform defaults", () => {
  assert.equal(resolveChromeBinary({ CHROME_BIN: "/custom/chrome" }, "linux"), "/custom/chrome");
  assert.equal(resolveChromeBinary({ CHROME_BIN: "C:\\Chrome.exe" }, "win32"), "C:\\Chrome.exe");
});

test("resolveChromeBinary returns the macOS default path", () => {
  assert.equal(resolveChromeBinary({}, "darwin"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
});

test("resolveChromeBinary finds Linux Chrome on PATH and reports a helpful error otherwise", async () => {
  const binDir = await mkdtemp(join(tmpdir(), "openwork-chrome-bin-"));
  const chromePath = join(binDir, "google-chrome");
  try {
    await writeFile(chromePath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(chromePath, 0o755);

    assert.equal(resolveChromeBinary({ PATH: binDir }, "linux"), chromePath);
    assert.throws(
      () => resolveChromeBinary({ PATH: "" }, "linux"),
      /Could not resolve Chrome binary on linux.*CHROME_BIN/,
    );
    assert.throws(
      () => resolveChromeBinary({}, "freebsd"),
      /unsupported platform freebsd/,
    );
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

test("freePort kills a real child listener and releases its port", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
  const port = await allocateFreePort();
  const child = spawn(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(Number(process.argv[1]), '127.0.0.1', () => process.stdout.write('ready\\n'))",
    String(port),
  ], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const logs: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Listener child did not bind port ${port}.`)), 5_000);
      child.once("error", reject);
      child.stdout?.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await freePort(port, { log: (message) => logs.push(message) });

    assert(logs.some((message) => message.includes(`Port ${port}`) && message.includes(String(child.pid))));
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("pruneStaleSurfaceProfiles removes untracked profiles and never touches live ones", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "openwork-surface-prune-"));
  const livePath = resolve(rootDir, "live-a");
  const stalePath = resolve(rootDir, "stale-b");
  const killed: string[] = [];
  try {
    await mkdir(livePath);
    await mkdir(stalePath);
    await writeFile(join(livePath, "marker.txt"), "keep", "utf8");
    await writeFile(join(stalePath, "marker.txt"), "remove", "utf8");

    const result = await pruneStaleSurfaceProfiles(rootDir, {
      live: new Set([livePath]),
      kill: async (path) => { killed.push(path); },
    });

    assert.deepEqual(result, { removed: [stalePath], kept: [livePath] });
    assert.equal(await readFile(join(livePath, "marker.txt"), "utf8"), "keep");
    await assert.rejects(access(stalePath));
    assert.deepEqual(killed, [stalePath]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("pruneStaleSurfaceProfiles kills only processes tied to stale profiles", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "openwork-surface-process-prune-"));
  const livePath = resolve(rootDir, "live-a");
  const stalePath = resolve(rootDir, "stale-b");
  await mkdir(livePath);
  await mkdir(stalePath);
  const liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", livePath], { detached: true, stdio: "ignore" });
  const staleChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", stalePath], { detached: true, stdio: "ignore" });
  if (!liveChild.pid || !staleChild.pid) throw new Error("Surface process fixtures did not start.");
  const livePid = liveChild.pid;
  const stalePid = staleChild.pid;
  try {
    await new Promise((done) => setTimeout(done, 100));
    await pruneStaleSurfaceProfiles(rootDir, { live: new Set([livePath]) });
    const deadline = Date.now() + 5_000;
    while (staleChild.exitCode === null && staleChild.signalCode === null && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }

    assert.notEqual(staleChild.signalCode, null, "stale profile process should be dead");
    assert.doesNotThrow(() => process.kill(livePid, 0));
  } finally {
    try { process.kill(livePid, "SIGKILL"); } catch {}
    try { process.kill(stalePid, "SIGKILL"); } catch {}
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("disposing a surface unregisters its profile so a later prune can remove it", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "openwork-surface-unregister-"));
  const profilePath = resolve(rootDir, "live-a");
  await mkdir(profilePath);
  try {
    registerLiveProfileRoot(profilePath);
    assert.deepEqual(await pruneStaleSurfaceProfiles(rootDir, { kill: async () => undefined }), {
      removed: [],
      kept: [profilePath],
    });
    unregisterLiveProfileRoot(profilePath);
    assert.deepEqual(await pruneStaleSurfaceProfiles(rootDir, { kill: async () => undefined }), {
      removed: [profilePath],
      kept: [],
    });
  } finally {
    unregisterLiveProfileRoot(profilePath);
    await rm(rootDir, { recursive: true, force: true });
  }
});
