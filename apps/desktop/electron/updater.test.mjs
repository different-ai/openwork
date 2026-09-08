import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  preventPendingUpdaterInstall,
  registerUpdaterIpc,
  staleUpdaterStatePaths,
  targetedStableUpdaterFeed,
} from "./updater.mjs";
import {
  cacheVerifiedRecoveryArtifact,
  compatibleRecoveryReleases,
  parseRecoveryManifest,
  readCachedRecoveryArtifact,
  readRecoveryState,
  recordHealthyVersion,
  recoveryManifestName,
  recoveryVersionMarkers,
  selectRecoveryArtifact,
} from "./recovery.mjs";

const fakeApp = { getPath: (key) => (key === "home" ? "/Users/test" : `/Users/test/${key}`) };

// Unpackaged builds resolve their version from package.json, so release bumps
// must not require touching this test.
const desktopVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

let isolatedUpdaterImportId = 0;

function fakeUpdaterHarness({ version }) {
  const listeners = new Map();
  const calls = [];
  const feeds = [];
  const downloadFeeds = [];
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
    allowPrerelease: false,
    allowDowngrade: false,
    on: (name, fn) => listeners.set(name, fn),
    setFeedURL: (feed) => feeds.push(feed),
    checkForUpdates: async () => ({ updateInfo: { version } }),
    downloadUpdate: async () => {
      calls.push("download");
      downloadFeeds.push(feeds.at(-1));
    },
    quitAndInstall: () => {
      calls.push("quitAndInstall");
    },
  };
  return { updater, listeners, calls, feeds, downloadFeeds };
}

async function registerFakeUpdaterIpc({ version }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openwork-updater-test-"));
  const handlers = new Map();
  const harness = fakeUpdaterHarness({ version });
  isolatedUpdaterImportId += 1;
  const updaterModuleUrl = new URL(
    `./updater.mjs?updater-lifecycle=${isolatedUpdaterImportId}`,
    import.meta.url,
  );
  const { registerUpdaterIpc: registerIsolatedUpdaterIpc } = await import(
    updaterModuleUrl.href
  );
  registerIsolatedUpdaterIpc({
    app: {
      isPackaged: true,
      getVersion: () => "0.17.0",
      getPath: (key) => path.join(tempDir, key),
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getMainWindow: () => null,
    loadAutoUpdater: async () => ({ autoUpdater: harness.updater }),
  });
  return { tempDir, handlers, ...harness };
}

describe("staleUpdaterStatePaths", () => {
  it("targets the ShipIt cache on macOS", { skip: process.platform !== "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), [
      "/Users/test/Library/Caches/com.differentai.openwork.ShipIt",
    ]);
  });

  it("is a no-op off macOS", { skip: process.platform === "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), []);
  });
});

describe("targetedStableUpdaterFeed", () => {
  it("builds a fixed GitHub release feed from a strict stable version", () => {
    assert.equal(
      targetedStableUpdaterFeed("0.17.22", "0.17.23"),
      "https://github.com/different-ai/openwork/releases/download/v0.17.23",
    );
  });

  it("rejects arbitrary URLs and prerelease targets", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.22", "https://example.test/latest.yml"),
      /stable x\.y\.z format/,
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.22", "0.17.23-alpha.1"),
      /stable x\.y\.z format/,
    );
  });

  it("rejects equal and older targets", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.23"),
      /newer than the installed version/,
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.22"),
      /newer than the installed version/,
    );
  });

  it("allows only an explicit exact recovery downgrade", () => {
    assert.equal(
      targetedStableUpdaterFeed("0.17.23", "0.17.22", true),
      "https://github.com/different-ai/openwork/releases/download/v0.17.22",
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.23", true),
      /must differ/,
    );
  });

  it("fails closed when the installed version cannot be compared", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("unknown", "0.17.23"),
      /could not be validated/,
    );
  });
});

describe("recovery metadata and candidates", () => {
  it("marks the installed version current and the last healthy version previous after a failed update boot", () => {
    assert.deepEqual(recoveryVersionMarkers("2.0.0", {
      currentVersion: "1.9.0",
      previousVersion: "1.8.0",
    }), {
      currentVersion: "2.0.0",
      previousVersion: "1.9.0",
    });
  });

  it("keeps the prior healthy version previous after the installed version boots successfully", () => {
    assert.deepEqual(recoveryVersionMarkers("2.0.0", {
      currentVersion: "2.0.0",
      previousVersion: "1.9.0",
    }), {
      currentVersion: "2.0.0",
      previousVersion: "1.9.0",
    });
  });

  it("atomically preserves the immediately prior healthy version", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-recovery-state-"));
    const app = { getPath: () => userData };
    try {
      await recordHealthyVersion(app, "public", "1.2.3");
      await recordHealthyVersion(app, "public", "1.2.4");
      await recordHealthyVersion(app, "public", "1.2.4");
      assert.deepEqual(await readRecoveryState(app, "public"), {
        currentVersion: "1.2.4",
        previousVersion: "1.2.3",
      });
      assert.match(await readFile(path.join(userData, "app-recovery.v1.json"), "utf8"), /"previousVersion": "1\.2\.3"/);
      assert.deepEqual(await readRecoveryState(app, "cloud"), {
        currentVersion: null,
        previousVersion: null,
      });
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("filters strict stable versions by minimum and fresh organization policy", async () => {
    const releases = await compatibleRecoveryReleases({
      versions: ["2.4.0", "2.3.1", "2.3.0-beta.1", "2.2.9", "https://invalid"],
      currentVersion: "2.4.0",
      previousVersion: "2.3.1",
      minimumVersion: "2.3.0",
      allowedVersions: ["2.4.0", "2.3.1"],
      resolveArtifact: async (version) => ({ url: `verified:${version}` }),
    });
    assert.deepEqual(releases.map(({ version, marking }) => ({ version, marking })), [
      { version: "2.4.0", marking: "current" },
      { version: "2.3.1", marking: "previous" },
    ]);
  });

  it("accepts only the exact platform, architecture, distribution release artifact", () => {
    const files = [
      { url: "openwork-mac-x64-1.2.3.dmg", sha512: "wrong-arch" },
      { url: "https://tampered.invalid/openwork-mac-arm64-1.2.3.dmg", sha512: "tampered" },
      { url: "openwork-mac-arm64-1.2.3.dmg", sha512: "verified" },
    ];
    assert.deepEqual(selectRecoveryArtifact(files, {
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
    }), {
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
      url: "https://github.com/different-ai/openwork/releases/download/v1.2.3/openwork-mac-arm64-1.2.3.dmg",
      sha512: "verified",
    });
    assert.equal(selectRecoveryArtifact(files, {
      version: "1.2.3-beta.1",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
    }), null);
  });

  it("accepts each artifact flavor only for its matching distribution", () => {
    const artifacts = {
      public: "openwork-mac-arm64-1.2.3.dmg",
      cloud: "openwork-cloud-mac-arm64-1.2.3.dmg",
      enterprise: "openwork-enterprise-mac-arm64-1.2.3.dmg",
    };
    for (const [distribution, fileName] of Object.entries(artifacts)) {
      const files = [{ url: fileName, sha512: `${distribution}-checksum` }];
      assert.equal(selectRecoveryArtifact(files, {
        version: "1.2.3", platform: "darwin", arch: "arm64", distribution,
      })?.url, `https://github.com/different-ai/openwork/releases/download/v1.2.3/${fileName}`);
      for (const otherDistribution of Object.keys(artifacts).filter((flavor) => flavor !== distribution)) {
        assert.equal(selectRecoveryArtifact(files, {
          version: "1.2.3", platform: "darwin", arch: "arm64", distribution: otherDistribution,
        }), null);
      }
    }
  });

  it("parses representative builder manifests and selects published installer extensions", () => {
    const files = parseRecoveryManifest(`version: 1.2.3
files:
  - url: openwork-mac-arm64-1.2.3.dmg
    sha512: mac-checksum
    size: 100
  - url: openwork-cloud-win-x64-1.2.3.exe
    sha512: win-checksum
  - url: openwork-enterprise-linux-x86_64-1.2.3.AppImage
    sha512: linux-checksum
path: openwork-mac-arm64-1.2.3.zip
sha512: updater-zip-checksum
releaseDate: '2026-08-11T00:00:00.000Z'
`);
    assert.equal(selectRecoveryArtifact(files, {
      version: "1.2.3", platform: "darwin", arch: "arm64", distribution: "public",
    })?.url.endsWith(".dmg"), true);
    assert.equal(selectRecoveryArtifact(files, {
      version: "1.2.3", platform: "win32", arch: "x64", distribution: "cloud",
    })?.url.endsWith(".exe"), true);
    assert.equal(selectRecoveryArtifact(files, {
      version: "1.2.3", platform: "linux", arch: "x64", distribution: "enterprise",
    })?.url.endsWith(".AppImage"), true);
    assert.equal(recoveryManifestName("darwin", "arm64", "public"), "latest-mac.yml");
    assert.equal(recoveryManifestName("win32", "x64", "cloud"), "cloud.yml");
    assert.equal(recoveryManifestName("linux", "arm64", "enterprise"), "enterprise-linux-arm64.yml");
  });

  it("rejects a checksum mismatch without producing a cached installer", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-recovery-checksum-"));
    try {
      await assert.rejects(
        cacheVerifiedRecoveryArtifact({
          app: { getPath: () => userData },
          artifact: { url: "https://github.com/different-ai/openwork/releases/download/v1.2.3/openwork.dmg", sha512: "invalid" },
          fetchArtifact: async () => new Response("tampered"),
        }),
        /checksum did not match/,
      );
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("preserves a valid rollback cache across network and checksum replacement failures", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-recovery-cache-preserve-"));
    const app = { getPath: () => userData };
    const bytes = Buffer.from("known-good");
    const artifact = {
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
      url: "https://github.com/different-ai/openwork/releases/download/v1.2.3/openwork-mac-arm64-1.2.3.dmg",
      sha512: createHash("sha512").update(bytes).digest("base64"),
    };
    try {
      await cacheVerifiedRecoveryArtifact({
        app,
        artifact,
        fetchArtifact: async () => new Response(bytes),
      });
      await assert.rejects(cacheVerifiedRecoveryArtifact({
        app,
        artifact: { ...artifact, version: "1.2.4", url: artifact.url.replace("1.2.3", "1.2.4") },
        fetchArtifact: async () => { throw new Error("offline"); },
      }), /offline/);
      await assert.rejects(cacheVerifiedRecoveryArtifact({
        app,
        artifact: { ...artifact, version: "1.2.4", url: artifact.url.replace("1.2.3", "1.2.4") },
        fetchArtifact: async () => new Response("tampered"),
      }), /checksum did not match/);
      assert.equal((await readCachedRecoveryArtifact(app, {
        platform: "darwin", arch: "arm64", distribution: "public",
      }))?.artifact.version, "1.2.3");
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("rejects cached metadata with a modified URL or wrong installer filename", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-recovery-cache-identity-"));
    const app = { getPath: () => userData };
    const bytes = Buffer.from("known-good-identity");
    const artifact = {
      version: "0.18.18",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
      url: "https://github.com/different-ai/openwork/releases/download/v0.18.18/openwork-mac-arm64-0.18.18.dmg",
      sha512: createHash("sha512").update(bytes).digest("base64"),
    };
    const expected = { platform: "darwin", arch: "arm64", distribution: "public" };
    try {
      await cacheVerifiedRecoveryArtifact({ app, artifact, fetchArtifact: async () => new Response(bytes) });
      const metadataPath = path.join(userData, "app-recovery-cache", "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      await writeFile(metadataPath, JSON.stringify({ ...metadata, url: "https://tampered.invalid/OpenWork.dmg" }), "utf8");
      assert.equal(await readCachedRecoveryArtifact(app, expected), null);
      await writeFile(metadataPath, JSON.stringify({ ...metadata, fileName: "OpenWork.dmg" }), "utf8");
      assert.equal(await readCachedRecoveryArtifact(app, expected), null);
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("discovers and opens a reverified cached healthy installer while offline", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-recovery-offline-"));
    const quitCalls = [];
    const app = {
      isPackaged: true,
      getVersion: () => "2.0.0",
      getPath: () => userData,
      quit: () => quitCalls.push("quit"),
    };
    const bytes = Buffer.from("offline-known-good");
    const artifact = {
      version: "1.9.0",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
      url: "https://github.com/different-ai/openwork/releases/download/v1.9.0/openwork-mac-arm64-1.9.0.dmg",
      sha512: createHash("sha512").update(bytes).digest("base64"),
    };
    const handlers = new Map();
    const opened = [];
    const networkCalls = [];
    let openError = "installer blocked";
    try {
      await recordHealthyVersion(app, "public", "1.9.0");
      await cacheVerifiedRecoveryArtifact({ app, artifact, fetchArtifact: async () => new Response(bytes) });
      isolatedUpdaterImportId += 1;
      const isolated = await import(`./updater.mjs?offline-recovery=${isolatedUpdaterImportId}`);
      isolated.registerUpdaterIpc({
        app,
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getMainWindow: () => null,
        electronNet: { fetch: async () => { networkCalls.push("fetch"); throw new Error("offline"); } },
        shell: { openPath: async (filePath) => { opened.push(filePath); return openError; } },
        platform: "darwin",
        arch: "arm64",
        distribution: "public",
      });
      const listed = await handlers.get("openwork:recovery:list")(null, {
        versions: [], minimumVersion: "0.0.0",
      });
      assert.deepEqual(listed.releases, [{ id: "1.9.0", version: "1.9.0", marking: "previous" }]);
      assert.deepEqual(networkCalls, []);
      assert.deepEqual(await handlers.get("openwork:recovery:use")(null, "1.9.0"), {
        ok: false,
        reason: "installer blocked",
      });
      assert.deepEqual(quitCalls, []);
      openError = "";
      assert.deepEqual(await handlers.get("openwork:recovery:use")(null, "1.9.0"), {
        ok: true,
        action: "installer",
        message: "The verified installer is open. Follow the operating system steps to finish.",
      });
      assert.equal(opened.length, 2);
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("rejects a candidate whose fresh manifest changes without any destructive action", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-recovery-fresh-mismatch-"));
    const handlers = new Map();
    const destructiveCalls = [];
    let candidateFetches = 0;
    const manifest = (checksum) => `version: 1.9.0\nfiles:\n  - url: openwork-mac-arm64-1.9.0.dmg\n    sha512: ${checksum}\n`;
    try {
      isolatedUpdaterImportId += 1;
      const isolated = await import(`./updater.mjs?fresh-mismatch=${isolatedUpdaterImportId}`);
      isolated.registerUpdaterIpc({
        app: {
          isPackaged: true,
          getVersion: () => "2.0.0",
          getPath: () => userData,
          quit: () => destructiveCalls.push("quit"),
        },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getMainWindow: () => null,
        electronNet: { fetch: async (url) => {
          if (!url.includes("/v1.9.0/")) return new Response("missing", { status: 404 });
          candidateFetches += 1;
          return new Response(manifest(candidateFetches === 1 ? "first-checksum" : "changed-checksum"));
        } },
        shell: { openPath: async () => { destructiveCalls.push("open"); return ""; } },
        platform: "darwin",
        arch: "arm64",
        distribution: "public",
      });
      const listed = await handlers.get("openwork:recovery:list")(null, {
        versions: ["1.9.0"], minimumVersion: "0.0.0",
      });
      assert.deepEqual(listed.releases, [{ id: "1.9.0", version: "1.9.0", marking: null }]);
      const result = await handlers.get("openwork:recovery:use")(null, "1.9.0");
      assert.equal(result.ok, false);
      assert.match(result.reason, /could not be verified/);
      assert.deepEqual(destructiveCalls, []);
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("does not download, install, or quit for an unverified renderer selection", async () => {
    const handlers = new Map();
    const destructiveCalls = [];
    registerUpdaterIpc({
      app: {
        isPackaged: true,
        getVersion: () => "1.2.3",
        getPath: () => os.tmpdir(),
        quit: () => destructiveCalls.push("quit"),
      },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getMainWindow: () => null,
      electronNet: { fetch: async () => {
        destructiveCalls.push("download");
        return new Response("unexpected");
      } },
      shell: { openPath: async () => {
        destructiveCalls.push("open");
        return "";
      } },
      env: {
        OPENWORK_EVAL_RECOVERY_CANDIDATES: JSON.stringify([
          { version: "1.2.2", verified: false, artifactUrl: "https://tampered.invalid/openwork.dmg" },
        ]),
      },
    });
    await handlers.get("openwork:recovery:list")(null, {});
    assert.equal((await handlers.get("openwork:recovery:use")(null, "1.2.2")).ok, false);
    assert.deepEqual(destructiveCalls, []);
  });
});

describe("installAndRestart", () => {
  it("refuses to invoke the installer before an update is downloaded", async () => {
    const handlers = new Map();
    registerUpdaterIpc({
      app: { isPackaged: false },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getMainWindow: () => null,
    });

    const install = handlers.get("openwork:updater:installAndRestart");
    assert.equal(typeof install, "function");
    assert.deepEqual(await install(), {
      ok: false,
      reason: "update-not-downloaded",
    });
  });
});

describe("downloaded update lifecycle", () => {
  it("a transient failed check does not invalidate a downloaded update", async () => {
    const { tempDir, handlers, updater, calls } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const download = handlers.get("openwork:updater:download");
      const install = handlers.get("openwork:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      assert.equal((await check(null, "stable")).available, true);
      assert.deepEqual(await download(), { ok: true });
      assert.equal(updater.autoInstallOnAppQuit, true);
      assert.deepEqual(calls, ["download"], "downloading must not quit the app");
      updater.checkForUpdates = async () => {
        throw new Error("network flake");
      };
      const failedCheck = await check(null, "stable");
      assert.equal(failedCheck.available, false);
      assert.match(failedCheck.reason, /network flake/);
      assert.deepEqual(await install(), { ok: true });
      assert.deepEqual(calls, ["download", "quitAndInstall"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("an updater error event does not invalidate a downloaded update", async () => {
    const { tempDir, handlers, listeners, calls } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const download = handlers.get("openwork:updater:download");
      const install = handlers.get("openwork:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      assert.equal((await check(null, "stable")).available, true);
      assert.deepEqual(await download(), { ok: true });
      const onError = listeners.get("error");
      assert.equal(typeof onError, "function");
      onError(new Error("network flake"));
      assert.deepEqual(await install(), { ok: true });
      assert.deepEqual(calls, ["download", "quitAndInstall"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("a successful check reporting no update still blocks install", async () => {
    const { tempDir, handlers, updater } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const download = handlers.get("openwork:updater:download");
      const install = handlers.get("openwork:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      assert.equal((await check(null, "stable")).available, true);
      assert.deepEqual(await download(), { ok: true });
      updater.checkForUpdates = async () => ({
        updateInfo: { version: "0.17.0" },
      });
      const currentCheck = await check(null, "stable");
      assert.equal(currentCheck.available, false);
      assert.deepEqual(await install(), {
        ok: false,
        reason: "update-not-downloaded",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("release channel changes", () => {
  it("prevents a previously downloaded update from installing on quit", () => {
    const updater = { autoInstallOnAppQuit: true };

    preventPendingUpdaterInstall(updater);
    assert.equal(updater.autoInstallOnAppQuit, false);
  });

  it("pins enterprise builds to their parallel stable manifest channel", async () => {
    const handlers = new Map();
    const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-enterprise-updater-"));
    try {
      registerUpdaterIpc({
        app: {
          isPackaged: false,
          getVersion: () => desktopVersion,
          getPath: () => userData,
        },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getMainWindow: () => null,
        manifestChannel: "enterprise",
      });

      const setChannel = handlers.get("openwork:updater:setChannel");
      assert.equal(typeof setChannel, "function");
      assert.deepEqual(await setChannel(null, "alpha"), {
        channel: "stable",
        feedUrl: "https://github.com/different-ai/openwork/releases/latest/download",
        currentVersion: desktopVersion,
      });
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("does not let a check overwrite the selected channel", {
    skip: process.platform !== "darwin",
  }, async () => {
    const { tempDir, handlers } = await registerFakeUpdaterIpc({
      version: "0.18.0",
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const setChannel = handlers.get("openwork:updater:setChannel");
      const getChannel = handlers.get("openwork:updater:getChannel");

      assert.equal((await setChannel(null, "alpha")).channel, "alpha");
      assert.equal((await check(null, "stable")).channel, "stable");
      assert.equal((await getChannel()).channel, "alpha");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("downloads from the channel used by the successful check", {
    skip: process.platform !== "darwin",
  }, async () => {
    const { tempDir, handlers, downloadFeeds } = await registerFakeUpdaterIpc({
      version: "0.18.0-alpha.1",
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const download = handlers.get("openwork:updater:download");

      assert.equal((await check(null, "alpha")).channel, "alpha");
      assert.deepEqual(await download(), { ok: true });
      assert.equal(
        downloadFeeds.at(-1)?.url,
        "https://github.com/different-ai/openwork/releases/download/alpha-macos-latest",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Alpha selected when a Stable check is already in flight", {
    skip: process.platform !== "darwin",
  }, async () => {
    const { tempDir, handlers, updater, feeds } = await registerFakeUpdaterIpc({
      version: "0.18.0",
    });
    /** @type {{ finish: null | (() => void) }} */
    const stableCheckControl = { finish: null };
    const stableCheckStarted = new Promise((resolve) => {
      updater.checkForUpdates = () => new Promise((finish) => {
        stableCheckControl.finish = () => finish({ updateInfo: { version: "0.18.0" } });
        resolve();
        updater.checkForUpdates = async () => ({ updateInfo: { version: "0.18.0-alpha.1" } });
      });
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const setChannel = handlers.get("openwork:updater:setChannel");
      const getChannel = handlers.get("openwork:updater:getChannel");

      const stableCheck = check(null, "stable");
      await stableCheckStarted;
      const alphaSelection = setChannel(null, "alpha");
      const alphaCheck = check(null, "alpha");
      const finishStableCheck = stableCheckControl.finish;
      if (!finishStableCheck) throw new Error("Stable update check did not start.");
      finishStableCheck();

      assert.equal((await stableCheck).channel, "stable");
      assert.equal((await alphaSelection).channel, "alpha");
      assert.equal((await alphaCheck).channel, "alpha");
      assert.equal((await getChannel()).channel, "alpha");
      assert.equal(
        JSON.parse(await readFile(
          path.join(tempDir, "userData", "electron-updater-channel.v1.json"),
          "utf8",
        )).channel,
        "alpha",
      );
      assert.equal(
        feeds.at(-1)?.url,
        "https://github.com/different-ai/openwork/releases/download/alpha-macos-latest",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
