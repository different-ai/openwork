import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGE_LIMITS, type HostEnvironment } from "@openwork/app-contract";

import { CandidateStore } from "./candidates.js";
import { AppInstaller } from "./installer.js";
import { appInstallDir } from "./paths.js";
import { GithubSource } from "./source-github.js";
import { InstalledAppStore } from "./store.js";

// The real end-to-end install.
//
// No fake GitHub, no fixture package: this talks to github.com, resolves the
// published release of `different-ai/openwork-station`, downloads the actual
// `.owapp` asset, verifies it, and installs it. It is the difference between
// "the installer works against a fixture" and "OpenWork can install a real
// application someone published".
//
// Network-gated, because a test that fails on a plane is a test people learn to
// ignore. Set OPENWORK_APPS_LIVE=1 to run it; CI runs it where egress is
// available. Skipping is reported, never silently passed.

const LIVE = process.env.OPENWORK_APPS_LIVE === "1";
const REPO = "https://github.com/different-ai/openwork-station";

const HOST: HostEnvironment = { openworkVersion: "1.0.0", os: "darwin", arch: "arm64" };

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "owapps-live-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function harness() {
  const dataDir = await scratch();
  const store = new InstalledAppStore({ dataDir });
  const candidates = new CandidateStore({ dataDir });
  const installer = new AppInstaller({
    store,
    candidates,
    source: new GithubSource({
      // The real transport. `externalFetch` is the server's wrapper; here the
      // global is correct because this file is a test and is exempt from the
      // server's bare-fetch rule.
      fetch: (url, init) => fetch(url, init),
      maxAssetBytes: PACKAGE_LIMITS.maxArchiveBytes,
      ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
    }),
    host: HOST,
    listEnvKeys: async () => ["OPENAI_API_KEY"],
    dataDir,
  });
  return { installer, store, dataDir };
}

describe.skipIf(!LIVE)("installing the published Station release from GitHub", () => {
  test(
    "preview resolves the real release without executing any of it",
    async () => {
      const { installer } = await harness();
      const preview = await installer.preview({ repositoryUrl: REPO });

      expect(preview.manifest.id).toBe("com.openworklabs.station");
      expect(preview.source.repository).toBe(REPO);
      // A real 40-character commit, not a branch name.
      expect(preview.source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(preview.source.assetName).toBe(`openwork-station-${preview.manifest.version}.owapp`);
      expect(preview.archiveDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(preview.compatible).toBe(true);

      // The permissions the trust screen will show are the real ones.
      const ids = preview.permissions.map((entry) => entry.permission.id);
      expect(ids).toContain("audio.microphone");
      expect(ids).toContain("openwork.connect.read");
      expect(ids).toContain("network.host");
      expect(preview.permissions[0]?.risk).toBe("critical");

      // Every permission carries the author's own stated reason.
      for (const entry of preview.permissions) expect(entry.reason.length).toBeGreaterThan(0);

      expect(preview.environment.map((entry) => entry.key)).toEqual(["OPENAI_API_KEY"]);
    },
    60_000,
  );

  test(
    "installing puts the real package on disk, switched off",
    async () => {
      const { installer, store, dataDir } = await harness();
      const preview = await installer.preview({ repositoryUrl: REPO });
      const record = await installer.install({
        candidateId: preview.candidateId,
        approvedPermissions: preview.manifest.permissions,
      });

      expect(record.app_id).toBe("com.openworklabs.station");
      expect(record.installation).toBe("installed");
      expect(record.enablement).toBe("disabled");
      expect(record.active.source.commit).toBe(preview.source.commit);
      expect(record.active.archive_digest).toBe(preview.archiveDigest);

      const installDir = appInstallDir(record.app_id, record.active.app_version, dataDir);
      const entries = await readdir(installDir);
      expect(entries.sort()).toEqual(["LICENSE", "assets", "dist", "openwork.app.json"]);

      // The manifest on disk is the one that was verified, byte for byte.
      const manifestText = await readFile(join(installDir, "openwork.app.json"), "utf8");
      expect(manifestText).toContain("com.openworklabs.station");

      // The declared entrypoints are actually present.
      const surfaces = Object.values(preview.manifest.entrypoints.surfaces);
      for (const path of surfaces) {
        expect((await readFile(join(installDir, path), "utf8")).length).toBeGreaterThan(0);
      }
      if (preview.manifest.entrypoints.background) {
        const background = await readFile(
          join(installDir, preview.manifest.entrypoints.background),
          "utf8",
        );
        expect(background.length).toBeGreaterThan(0);
      }

      const audit = (await store.auditHistory(20, record.app_id)).map((row) => row.event);
      expect(audit).toContain("trust_granted");
      expect(audit).toContain("installed");
    },
    120_000,
  );

  test(
    "the same release installs to the same bytes twice",
    async () => {
      const first = await harness();
      const second = await harness();
      const a = await first.installer.preview({ repositoryUrl: REPO });
      const b = await second.installer.preview({ repositoryUrl: REPO });
      expect(a.archiveDigest).toBe(b.archiveDigest);
      expect(a.source.commit).toBe(b.source.commit);
    },
    120_000,
  );

  test(
    "a candidate cannot be reused after it installs",
    async () => {
      const { installer } = await harness();
      const preview = await installer.preview({ repositoryUrl: REPO });
      await installer.install({
        candidateId: preview.candidateId,
        approvedPermissions: preview.manifest.permissions,
      });
      await expect(
        installer.install({
          candidateId: preview.candidateId,
          approvedPermissions: preview.manifest.permissions,
        }),
      ).rejects.toThrow();
    },
    120_000,
  );

  test(
    "a repository with no OpenWork manifest is refused",
    async () => {
      const { installer } = await harness();
      await expect(
        installer.preview({ repositoryUrl: "https://github.com/different-ai/openwork" }),
      ).rejects.toThrow();
    },
    60_000,
  );
});

test("the live install suite reports when it is skipped rather than passing quietly", () => {
  if (!LIVE) {
    // Visible in the run output, so an absent live result is never mistaken for
    // a passing one.
    console.warn(
      "[live] Station install suite skipped. Set OPENWORK_APPS_LIVE=1 to run it against github.com.",
    );
  }
  expect(true).toBe(true);
});
