import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  BLANK_SLATE_PATH_ENV_KEYS,
  prepareBlankSlateProfile,
  resolveBlankSlateLaunch,
} from "./blank-slate-profile.mjs";

const execFileAsync = promisify(execFile);

test("normal launches remain unchanged", () => {
  const env = {
    HOME: "/Users/installed",
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: "/Users/installed/.config/openwork/desktop-bootstrap.json",
  };
  const originalEnv = { ...env };
  const profile = prepareBlankSlateProfile({
    argv: [],
    env,
    createTempRoot: () => assert.fail("normal launch created a temporary root"),
    createDirectory: () => assert.fail("normal launch created a profile directory"),
  });

  assert.equal(profile, null);
  assert.deepEqual(env, originalEnv);
  assert.deepEqual(resolveBlankSlateLaunch({ appName: "OpenWork", profile }), {
    enabled: false,
    appName: "OpenWork",
    userDataPath: null,
  });
});

test("cleanup worker removes the entire temporary root after its parent exits", async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), "openwork-cleanup-test-"));
  const userDataPath = path.join(rootPath, "electron", "user-data");
  const configPath = path.join(rootPath, "openwork", "config");
  await mkdir(userDataPath, { recursive: true });
  await mkdir(configPath, { recursive: true });
  await writeFile(path.join(userDataPath, "Preferences"), "test");
  await writeFile(path.join(configPath, "server.json"), "{}");

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("./blank-slate-cleanup.mjs", import.meta.url)),
    "2147483647",
    rootPath,
  ]);

  await assert.rejects(() => rm(rootPath));
});

test("blank-slate launches receive unique temporary roots and a visible name", async () => {
  const firstProfile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: {} });
  const secondProfile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: {} });
  const first = resolveBlankSlateLaunch({ appName: "OpenWork", profile: firstProfile });
  const second = resolveBlankSlateLaunch({ appName: "OpenWork", profile: secondProfile });

  try {
    assert.equal(first.appName, "OpenWork - Test profile");
    assert.equal(first.enabled, true);
    assert.ok(first.rootPath.startsWith(tmpdir()));
    assert.notEqual(first.rootPath, second.rootPath);
    assert.ok(first.userDataPath.startsWith(first.rootPath));
    assert.ok(!first.rootPath.includes("com.differentai.openwork"));
  } finally {
    await Promise.all([
      rm(first.rootPath, { recursive: true, force: true }),
      rm(second.rootPath, { recursive: true, force: true }),
    ]);
  }
});

test("process profile hides an installed bootstrap before workspace-store loads", async () => {
  const installedRoot = await mkdtemp(path.join(tmpdir(), "openwork-installed-profile-test-"));
  const installedBootstrapPath = path.join(installedRoot, "desktop-bootstrap.json");
  await writeFile(installedBootstrapPath, JSON.stringify({
    baseUrl: "http://localhost:3005",
    requireSignin: false,
  }));

  const profileModuleUrl = new URL("./blank-slate-profile.mjs", import.meta.url).href;
  const workspaceStoreModuleUrl = new URL("./workspace-store.mjs", import.meta.url).href;
  const script = `
    import { rmSync } from "node:fs";
    process.argv.push("--blank-slate");
    const { processBlankSlateProfile } = await import(${JSON.stringify(profileModuleUrl)});
    const { createWorkspaceStore } = await import(${JSON.stringify(workspaceStoreModuleUrl)});
    try {
      const store = createWorkspaceStore({
        app: { getPath: () => processBlankSlateProfile.userDataPath },
        defaultDenBaseUrl: "https://api.openworklabs.com",
        defaultRequireSignin: true,
        forceRequireSignin: true,
      });
      console.log(JSON.stringify({
        bootstrap: store.readDesktopBootstrapConfigSync(),
        bootstrapPath: process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH,
        rootPath: processBlankSlateProfile.rootPath,
      }));
    } finally {
      rmSync(processBlankSlateProfile.rootPath, { recursive: true, force: true });
    }
  `;

  try {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        OPENWORK_DESKTOP_BOOTSTRAP_PATH: installedBootstrapPath,
      },
    });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.bootstrap, {
      baseUrl: "https://api.openworklabs.com",
      requireSignin: true,
      installationRequiresSignin: false,
      fromFile: false,
    });
    assert.notEqual(result.bootstrapPath, installedBootstrapPath);
    assert.ok(result.bootstrapPath.startsWith(result.rootPath));
  } finally {
    await rm(installedRoot, { recursive: true, force: true });
  }
});

/**
 * @param {NodeJS.Platform} platform
 * @param {string} temporaryDirectory
 * @param {string} rootPath
 */
function registerPlatformIsolationTest(platform, temporaryDirectory, rootPath) {
  test(`blank-slate isolates every persisted path on ${platform}`, () => {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const env = {
      HOME: paths.join(paths.parse(rootPath).root, "installed", "home"),
      OPENWORK_DESKTOP_DISTRIBUTION: "enterprise",
      OPENWORK_SERVER_CONFIG: paths.join(paths.parse(rootPath).root, "installed", "server.json"),
    };
    const createdDirectories = [];
    const profile = prepareBlankSlateProfile({
      argv: ["desktop", "--blank-slate"],
      env,
      platform,
      temporaryDirectory,
      createTempRoot: (prefix) => {
        assert.equal(prefix, paths.join(temporaryDirectory, "openwork-test-profile-"));
        return rootPath;
      },
      createDirectory: (directory) => createdDirectories.push(directory),
    });

    assert.ok(profile);
    assert.equal(env.OPENWORK_DESKTOP_DISTRIBUTION, "enterprise");
    assert.ok(!Object.hasOwn(env, "OPENWORK_DEV_MODE"));
    assert.equal(env.HOME, profile.homePath);
    assert.equal(env.USERPROFILE, profile.homePath);
    for (const key of BLANK_SLATE_PATH_ENV_KEYS) {
      assert.equal(env[key], profile.environment[key]);
      const relative = paths.relative(profile.rootPath, env[key]);
      assert.ok(relative && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative), `${key} escaped the temporary root`);
    }
    for (const directory of createdDirectories) {
      const relative = paths.relative(profile.rootPath, directory);
      assert.ok(relative && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative), `${directory} escaped the temporary root`);
    }
  });
}

registerPlatformIsolationTest("darwin", "/private/tmp", "/private/tmp/openwork-test-profile-macos");
registerPlatformIsolationTest("linux", "/tmp", "/tmp/openwork-test-profile-linux");
registerPlatformIsolationTest("win32", "C:\\Temp", "C:\\Temp\\openwork-test-profile-windows");
