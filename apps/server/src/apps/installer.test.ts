import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  permissionKey,
  stringifyJsonCanonical,
  type AppManifest,
  type AppPermission,
  type HostEnvironment,
} from "@openwork/app-contract";
import { packApp } from "@openwork/app-tools";

import { CandidateStore } from "./candidates.js";
import { AppInstaller, InstallError } from "./installer.js";
import { appDataDir, appInstallDir } from "./paths.js";
import { GithubSource, SourceError, parseRepositoryUrl, type FetchLike } from "./source-github.js";
import { InstalledAppStore } from "./store.js";

// End-to-end installer behaviour against a fake GitHub.
//
// The fake is a real HTTP-shaped surface, not a stub of the installer: it serves
// release JSON, tag refs, a manifest blob, and archive bytes, so preview and
// install exercise the same code paths they will in production. Attacks are
// expressed by changing what the fake serves between calls, which is exactly how
// a moved release or a swapped asset would present.

const HOST: HostEnvironment = { openworkVersion: "1.0.0", os: "darwin", arch: "arm64" };
const REPO = "https://github.com/different-ai/openwork-station";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "owapps-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function manifest(overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    manifest_version: 1,
    id: "com.openworklabs.station",
    name: "OpenWork Station",
    description: "Ambient assistant.",
    version: "1.0.0",
    publisher: { name: "OpenWork Labs" },
    repository: REPO,
    license: "MIT",
    icons: { default: "assets/icon.svg" },
    engines: { openwork: { min: "0.1.0" }, app_api: { min: "1.0.0", max_exclusive: "2.0.0" } },
    platforms: [{ os: "darwin", arch: ["arm64", "x64"] }],
    distribution: { type: "github-release", repository: REPO, asset: "station-{version}.owapp" },
    entrypoints: { surfaces: { main: "dist/index.html" } },
    contributions: [
      {
        type: "surface",
        id: "main",
        entrypoint: "main",
        presentation: "panel",
        default_size: { width: 320, height: 240 },
      },
      {
        type: "right_sidebar_item",
        id: "rail",
        label: "Station",
        surface: "main",
        icon: "assets/icon.svg",
      },
    ],
    permissions: [{ id: "storage.app", reason: "Remember cards.", quota_bytes: 1024 }],
    environment: { required: [], optional: [] },
    privacy: {
      summary: "Nothing leaves the machine.",
      data_handled: ["none"],
      retention: { policy: "none", description: "Nothing is kept." },
      third_parties: [],
    },
    update: { channel: "github-release", rollback_supported: true },
    ...overrides,
  };
}

/**
 * Pack a release.
 *
 * `packagedManifest` is what goes *inside* the archive, and it defaults to the
 * repository manifest because that is the honest case. Passing a different one is
 * how a test plays a publisher whose shipped bytes disagree with the manifest the
 * review screen read — and that divergence is exactly what every test here used
 * to be unable to express, because one object was packed and served.
 */
function buildPackage(
  source: AppManifest,
  commit = COMMIT_A,
  packagedManifest: AppManifest = source,
) {
  const files = new Map<string, Uint8Array>([
    ["assets/icon.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["dist/index.html", Buffer.from("<!doctype html><title>Station</title>")],
  ]);
  const manifestText = stringifyJsonCanonical(packagedManifest);
  const result = packApp({
    manifestText,
    files,
    source: { repository: REPO, release_tag: `v${packagedManifest.version}`, commit },
  });
  if (!result.ok) {
    throw new Error(`fixture failed to pack: ${result.diagnostics.map((d) => d.message).join("; ")}`);
  }
  return { ...result, manifestText };
}

type FakeState = {
  manifest: AppManifest;
  archive: Uint8Array;
  manifestText: string;
  commit: string;
  tag: string;
  assetName: string;
  assets?: Array<{ name: string; browser_download_url: string; size: number }>;
  missingRelease?: boolean;
  draft?: boolean;
  prerelease?: boolean;
};

/** A GitHub stand-in whose served content the test can change mid-flight. */
function fakeGithub(state: FakeState) {
  const calls: string[] = [];
  const fetchLike: FetchLike = async (url) => {
    calls.push(url);
    const json = (value: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => value,
      text: async () => JSON.stringify(value),
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => null },
    });

    if (url.includes("/releases/latest") || url.includes("/releases/tags/")) {
      if (state.missingRelease) return json({ message: "Not Found" }, 404);
      return json({
        tag_name: state.tag,
        draft: state.draft ?? false,
        prerelease: state.prerelease ?? false,
        published_at: "2026-07-29T00:00:00Z",
        assets: state.assets ?? [
          { name: state.assetName, browser_download_url: "https://objects/asset", size: state.archive.byteLength },
        ],
      });
    }
    if (url.includes("/git/ref/tags/")) {
      return json({ object: { sha: state.commit, type: "commit" } });
    }
    if (url.includes("/contents/openwork.app.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => state.manifestText,
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      };
    }
    if (url.startsWith("https://objects/")) {
      const bytes = state.archive;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        headers: { get: () => null },
      };
    }
    return json({ message: "Not Found" }, 404);
  };
  return { fetchLike, calls };
}

type Harness = {
  installer: AppInstaller;
  store: InstalledAppStore;
  candidates: CandidateStore;
  state: FakeState;
  dataDir: string;
  envKeys: Set<string>;
  calls: string[];
  now: { value: number };
};

async function harness(overrides: Partial<AppManifest> = {}): Promise<Harness> {
  const dataDir = await scratch();
  const source = manifest(overrides);
  const built = buildPackage(source);
  const state: FakeState = {
    manifest: source,
    archive: built.archive,
    manifestText: built.manifestText,
    commit: COMMIT_A,
    tag: `v${source.version}`,
    assetName: built.assetName,
  };
  const { fetchLike, calls } = fakeGithub(state);
  const envKeys = new Set<string>();
  const now = { value: 1_700_000_000_000 };

  const store = new InstalledAppStore({ dataDir });
  const candidates = new CandidateStore({ dataDir, now: () => now.value });
  const installer = new AppInstaller({
    store,
    candidates,
    source: new GithubSource({ fetch: fetchLike, maxAssetBytes: 96 * 1024 * 1024 }),
    host: HOST,
    listEnvKeys: async () => [...envKeys],
    dataDir,
    now: () => now.value,
  });
  return { installer, store, candidates, state, dataDir, envKeys, calls, now };
}

async function previewAndInstall(h: Harness) {
  const preview = await h.installer.preview({ repositoryUrl: REPO });
  return h.installer.install({
    candidateId: preview.candidateId,
    approvedPermissions: preview.manifest.permissions,
  });
}

// The manifest the user reviews comes from the repository at the pinned commit;
// the manifest inside the package is a separate document the publisher controls.
// If nothing binds them, the review screen shows one permission set and the
// installer grants another, and every other guarantee in this file is decoration.
describe("the reviewed manifest is the manifest that governs", () => {
  const benign = () => manifest();
  const hostile = () =>
    manifest({
      permissions: [
        { id: "storage.app", reason: "Remember cards.", quota_bytes: 1024 },
        { id: "audio.microphone", reason: "Listen." },
        {
          id: "openwork.connect.read",
          reason: "Read mail.",
          scopes: ["gmail.search", "slack.search"],
        },
        { id: "network.host", reason: "Phone home.", hosts: ["attacker.example"] },
      ],
      privacy: {
        summary: "Nothing leaves the machine.",
        data_handled: ["microphone-audio", "connected-source-content"],
        retention: { policy: "none", description: "Nothing is kept." },
        third_parties: [],
      },
    });

  test("a package whose manifest declares extra permissions is refused at preview", async () => {
    const h = await harness();
    const repo = benign();
    const built = buildPackage(repo, COMMIT_A, hostile());
    h.state.manifest = repo;
    h.state.manifestText = stringifyJsonCanonical(repo);
    h.state.archive = built.archive;
    h.state.assetName = built.assetName;

    await expect(h.installer.preview({ repositoryUrl: REPO })).rejects.toThrow(/verification/i);
  });

  test("the divergence is reported as a manifest divergence, not a generic failure", async () => {
    const h = await harness();
    const repo = benign();
    const built = buildPackage(repo, COMMIT_A, hostile());
    h.state.manifestText = stringifyJsonCanonical(repo);
    h.state.archive = built.archive;
    h.state.assetName = built.assetName;

    const error = await h.installer.preview({ repositoryUrl: REPO }).catch((thrown) => thrown);
    const codes = (error.diagnostics ?? []).map((d: { code: string }) => d.code);
    expect(codes).toContain("package.manifest_divergence");
  });

  test("a package that agrees with the repository installs normally", async () => {
    const h = await harness();
    const record = await previewAndInstall(h);
    expect(record.granted_permissions.map((entry) => entry.id)).toEqual(["storage.app"]);
  });

  test("the grant equals what preview displayed, permission for permission", async () => {
    const h = await harness();
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    const record = await h.installer.install({
      candidateId: preview.candidateId,
      approvedPermissions: preview.manifest.permissions,
    });
    expect(record.granted_permissions.map(permissionKey).sort()).toEqual(
      preview.permissions.map((entry) => permissionKey(entry.permission)).sort(),
    );
  });
});

describe("repository URL parsing", () => {
  test("it accepts what a user actually pastes", () => {
    for (const input of [
      "https://github.com/different-ai/openwork-station",
      "github.com/different-ai/openwork-station",
      "https://github.com/different-ai/openwork-station.git",
      "https://github.com/different-ai/openwork-station/tree/main/src",
      "  https://github.com/different-ai/openwork-station  ",
    ]) {
      expect(parseRepositoryUrl(input).canonicalUrl).toBe(REPO);
    }
  });

  test("it refuses non-GitHub, non-https, and malformed input", () => {
    for (const input of [
      "http://github.com/a/b",
      "https://gitlab.com/a/b",
      "https://github.com/onlyowner",
      "not a url at all",
      "",
    ]) {
      expect(() => parseRepositoryUrl(input)).toThrow(SourceError);
    }
  });
});

describe("preview", () => {
  test("it resolves, verifies, and describes without installing anything", async () => {
    const h = await harness();
    const preview = await h.installer.preview({ repositoryUrl: REPO });

    expect(preview.manifest.id).toBe("com.openworklabs.station");
    expect(preview.source.commit).toBe(COMMIT_A);
    expect(preview.source.releaseTag).toBe("v1.0.0");
    expect(preview.archiveDigest.startsWith("sha256:")).toBe(true);
    expect(preview.compatible).toBe(true);
    expect(await h.store.list()).toEqual([]);
  });

  test("it never fetches from a branch, only from the resolved commit", async () => {
    const h = await harness();
    await h.installer.preview({ repositoryUrl: REPO });
    const manifestCall = h.calls.find((url) => url.includes("/contents/openwork.app.json"));
    expect(manifestCall).toContain(`ref=${COMMIT_A}`);
    expect(h.calls.some((url) => url.includes("ref=main") || url.includes("ref=HEAD"))).toBe(false);
  });

  test("permissions are summarised critical-first", async () => {
    const h = await harness({
      permissions: [
        { id: "storage.app", reason: "cache", quota_bytes: 1024 },
        { id: "audio.microphone", reason: "listen" },
      ],
      privacy: {
        summary: "Audio is transcribed.",
        data_handled: ["microphone-audio"],
        retention: { policy: "session", description: "Dropped on stop." },
        third_parties: [],
      },
    });
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    expect(preview.permissions[0]?.permission.id).toBe("audio.microphone");
    expect(preview.permissions[0]?.risk).toBe("critical");
    expect(preview.permissions[0]?.reason).toBe("listen");
  });

  test("an unconfigured required secret is a warning, not a failure", async () => {
    const h = await harness({
      environment: {
        required: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }],
        optional: [],
      },
    });
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    expect(preview.environment[0]).toEqual({
      key: "OPENAI_API_KEY",
      label: "OpenAI API key",
      required: true,
      configured: false,
    });
    expect(preview.warnings.join(" ")).toContain("not configured");
  });

  test("a repository with no release is refused with a useful message", async () => {
    const h = await harness();
    h.state.missingRelease = true;
    await expect(h.installer.preview({ repositoryUrl: REPO })).rejects.toThrow(SourceError);
  });

  test("a draft release is not installable", async () => {
    const h = await harness();
    h.state.draft = true;
    await expect(h.installer.preview({ repositoryUrl: REPO })).rejects.toThrow(SourceError);
  });

  test("a prerelease previews with a warning", async () => {
    const h = await harness();
    h.state.prerelease = true;
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    expect(preview.warnings.join(" ")).toContain("prerelease");
  });

  test("a release missing the declared asset is refused", async () => {
    const h = await harness();
    h.state.assets = [
      { name: "something-else.zip", browser_download_url: "https://objects/asset", size: 10 },
    ];
    await expect(h.installer.preview({ repositoryUrl: REPO })).rejects.toThrow(SourceError);
  });

  test("a manifest claiming a different repository is refused", async () => {
    const h = await harness();
    const foreign = manifest({ repository: "https://github.com/someone/else" });
    h.state.manifestText = stringifyJsonCanonical(foreign);
    await expect(h.installer.preview({ repositoryUrl: REPO })).rejects.toThrow(InstallError);
  });

  test("an invalid manifest is refused with diagnostics", async () => {
    const h = await harness();
    h.state.manifestText = '{"manifest_version": 1, "id": "nope"}';
    const error = await h.installer.preview({ repositoryUrl: REPO }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) {
      expect(error.code).toBe("invalid_manifest");
      expect(error.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("an incompatible platform previews but is marked incompatible", async () => {
    const h = await harness({ platforms: [{ os: "win32", arch: ["x64"] }] });
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    expect(preview.compatible).toBe(false);
    expect(preview.warnings.join(" ")).toContain("does not support darwin/arm64");
  });
});

describe("install", () => {
  test("an app installs disabled, with its permissions granted", async () => {
    const h = await harness();
    const record = await previewAndInstall(h);
    expect(record.installation).toBe("installed");
    expect(record.enablement).toBe("disabled");
    expect(record.setup).toBe("ready");
    expect(record.granted_permissions.map((p) => p.id)).toEqual(["storage.app"]);
    const files = await readdir(appInstallDir(record.app_id, "1.0.0", h.dataDir));
    expect(files.sort()).toEqual(["assets", "dist", "openwork.app.json"]);
  });

  test("an app needing an unset secret installs in setup_required", async () => {
    const h = await harness({
      environment: { required: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }], optional: [] },
    });
    const record = await previewAndInstall(h);
    expect(record.setup).toBe("setup_required");
    expect(record.enablement).toBe("disabled");
  });

  test("install consumes the candidate and refuses a replay", async () => {
    const h = await harness();
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    await h.installer.install({
      candidateId: preview.candidateId,
      approvedPermissions: preview.manifest.permissions,
    });
    const error = await h.installer
      .install({ candidateId: preview.candidateId, approvedPermissions: preview.manifest.permissions })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) expect(error.code).toBe("candidate_replayed");
  });

  test("an expired candidate cannot be installed", async () => {
    const h = await harness();
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    h.now.value += 16 * 60_000;
    const error = await h.installer
      .install({ candidateId: preview.candidateId, approvedPermissions: preview.manifest.permissions })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) expect(error.code).toBe("candidate_expired");
  });

  test("an unknown candidate is refused", async () => {
    const h = await harness();
    const error = await h.installer
      .install({ candidateId: "never-existed", approvedPermissions: [] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) expect(error.code).toBe("candidate_not_found");
  });

  test("approving fewer permissions than were reviewed installs nothing", async () => {
    const h = await harness({
      permissions: [
        { id: "storage.app", reason: "cache", quota_bytes: 1024 },
        { id: "desktop.globalShortcut", reason: "toggle", shortcuts: [{ id: "s", default_accelerator: "Alt+K" }] },
      ],
      contributions: [
        {
          type: "surface",
          id: "main",
          entrypoint: "main",
          presentation: "panel",
          default_size: { width: 320, height: 240 },
        },
        { type: "command", id: "c", title: "Toggle" },
        { type: "shortcut", id: "s", command: "c", global: true },
      ],
    });
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    const error = await h.installer
      .install({
        candidateId: preview.candidateId,
        approvedPermissions: preview.manifest.permissions.slice(0, 1),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) expect(error.code).toBe("permission_mismatch");
    expect(await h.store.list()).toEqual([]);
  });

  test("approving a permission that was never reviewed installs nothing", async () => {
    const h = await harness();
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    const smuggled: AppPermission = { id: "audio.microphone", reason: "listen" };
    const error = await h.installer
      .install({
        candidateId: preview.candidateId,
        approvedPermissions: [...preview.manifest.permissions, smuggled],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) expect(error.code).toBe("permission_mismatch");
  });

  test("a release swapped between preview and install cannot be installed", async () => {
    const h = await harness();
    const preview = await h.installer.preview({ repositoryUrl: REPO });

    // The attacker moves the tag and replaces the asset with a package that
    // demands the microphone. The candidate is already pinned to the old bytes.
    const hostile = manifest({
      version: "1.0.0",
      permissions: [{ id: "audio.microphone", reason: "listen" }],
      privacy: {
        summary: "Audio is transcribed.",
        data_handled: ["microphone-audio"],
        retention: { policy: "session", description: "Dropped." },
        third_parties: [],
      },
    });
    const rebuilt = buildPackage(hostile, COMMIT_B);
    h.state.archive = rebuilt.archive;
    h.state.manifestText = rebuilt.manifestText;
    h.state.commit = COMMIT_B;

    // Install still succeeds, and installs exactly what was reviewed: the
    // pinned bytes, not the swapped ones.
    const record = await h.installer.install({
      candidateId: preview.candidateId,
      approvedPermissions: preview.manifest.permissions,
    });
    expect(record.granted_permissions.map((p) => p.id)).toEqual(["storage.app"]);
    expect(record.active.source.commit).toBe(COMMIT_A);
    expect(record.active.archive_digest).toBe(preview.archiveDigest);
  });

  test("installing the same app twice is refused", async () => {
    const h = await harness();
    await previewAndInstall(h);
    const error = await previewAndInstall(h).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) expect(error.code).toBe("already_installed");
  });
});

describe("setup and enablement", () => {
  test("an app cannot be enabled until its required secret exists", async () => {
    const h = await harness({
      environment: { required: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }], optional: [] },
    });
    const record = await previewAndInstall(h);
    await expect(h.installer.enable(record.app_id)).rejects.toThrow(InstallError);

    h.envKeys.add("OPENAI_API_KEY");
    const enabled = await h.installer.enable(record.app_id);
    expect(enabled.enablement).toBe("enabled");
    expect(enabled.setup).toBe("ready");
  });

  test("deleting the secret disables the app again", async () => {
    const h = await harness({
      environment: { required: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }], optional: [] },
    });
    const record = await previewAndInstall(h);
    h.envKeys.add("OPENAI_API_KEY");
    await h.installer.enable(record.app_id);

    h.envKeys.delete("OPENAI_API_KEY");
    const refreshed = await h.installer.refreshSetup(record.app_id);
    expect(refreshed?.setup).toBe("setup_required");
    expect(refreshed?.enablement).toBe("disabled");
  });

  test("disable is idempotent and audited", async () => {
    const h = await harness();
    const record = await previewAndInstall(h);
    await h.installer.enable(record.app_id);
    expect((await h.installer.disable(record.app_id)).enablement).toBe("disabled");
    expect((await h.installer.disable(record.app_id)).enablement).toBe("disabled");
    const history = await h.store.auditHistory(50, record.app_id);
    expect(history.filter((row) => row.event === "disabled")).toHaveLength(2);
  });

  test("revoking a permission drops it and stops the app", async () => {
    const h = await harness();
    const record = await previewAndInstall(h);
    await h.installer.enable(record.app_id);
    const revoked = await h.installer.revokePermission(record.app_id, "storage.app");
    expect(revoked.granted_permissions).toEqual([]);
    expect(revoked.enablement).toBe("disabled");
  });
});

describe("updates", () => {
  async function installThenOffer(next: AppManifest) {
    const h = await harness();
    const record = await previewAndInstall(h);
    await h.installer.enable(record.app_id);
    const rebuilt = buildPackage(next, COMMIT_B);
    h.state.manifest = next;
    h.state.archive = rebuilt.archive;
    h.state.manifestText = rebuilt.manifestText;
    h.state.commit = COMMIT_B;
    h.state.tag = `v${next.version}`;
    h.state.assetName = rebuilt.assetName;
    h.state.assets = [
      { name: rebuilt.assetName, browser_download_url: "https://objects/asset", size: rebuilt.archive.byteLength },
    ];
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    return { h, record, preview };
  }

  test("an update with no new permissions applies immediately", async () => {
    const { h, preview } = await installThenOffer(manifest({ version: "1.1.0" }));
    const result = await h.installer.update({
      appId: "com.openworklabs.station",
      candidateId: preview.candidateId,
      approvedPermissions: preview.manifest.permissions,
    });
    expect(result.applied).toBe(true);
    expect(result.delta.requiresReview).toBe(false);
    expect(result.record.active.app_version).toBe("1.1.0");
    expect(result.record.previous?.app_version).toBe("1.0.0");
  });

  test("an update requesting a new permission is withheld until reviewed", async () => {
    const { h, preview } = await installThenOffer(
      manifest({
        version: "1.1.0",
        permissions: [
          { id: "storage.app", reason: "cache", quota_bytes: 1024 },
          { id: "audio.microphone", reason: "listen" },
        ],
        privacy: {
          summary: "Audio is transcribed.",
          data_handled: ["microphone-audio"],
          retention: { policy: "session", description: "Dropped." },
          third_parties: [],
        },
      }),
    );
    const result = await h.installer.update({
      appId: "com.openworklabs.station",
      candidateId: preview.candidateId,
      approvedPermissions: preview.manifest.permissions,
    });
    expect(result.applied).toBe(false);
    expect(result.delta.requiresReview).toBe(true);
    expect(result.record.installation).toBe("update_pending_review");
    expect(result.record.active.app_version).toBe("1.0.0");
    expect(result.record.granted_permissions.map((p) => p.id)).toEqual(["storage.app"]);

    // A withheld update also blocks enabling until the user deals with it.
    await expect(h.installer.enable("com.openworklabs.station")).rejects.toThrow(InstallError);

    const approved = await h.installer.approvePendingUpdate("com.openworklabs.station");
    expect(approved.active.app_version).toBe("1.1.0");
    expect(approved.granted_permissions.map((p) => p.id).sort()).toEqual([
      "audio.microphone",
      "storage.app",
    ]);
  });

  test("an update that widens an existing permission also requires review", async () => {
    const { h, preview } = await installThenOffer(
      manifest({
        version: "1.1.0",
        permissions: [{ id: "storage.app", reason: "cache", quota_bytes: 8 * 1024 * 1024 }],
      }),
    );
    const result = await h.installer.update({
      appId: "com.openworklabs.station",
      candidateId: preview.candidateId,
      approvedPermissions: preview.manifest.permissions,
    });
    expect(result.applied).toBe(false);
    expect(result.delta.entries[0]?.change).toBe("widened");
  });

  test("an update that only drops a permission applies immediately", async () => {
    const { h, preview } = await installThenOffer(manifest({ version: "1.1.0", permissions: [] }));
    const result = await h.installer.update({
      appId: "com.openworklabs.station",
      candidateId: preview.candidateId,
      approvedPermissions: [],
    });
    expect(result.applied).toBe(true);
    expect(result.record.granted_permissions).toEqual([]);
  });

  test("a downgrade is refused", async () => {
    const { h, preview } = await installThenOffer(manifest({ version: "0.9.0" }));
    const error = await h.installer
      .update({
        appId: "com.openworklabs.station",
        candidateId: preview.candidateId,
        approvedPermissions: preview.manifest.permissions,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) expect(error.code).toBe("not_an_upgrade");
  });
});

describe("rollback", () => {
  test("rollback restores the previous verified package, stopped", async () => {
    const h = await harness();
    await previewAndInstall(h);
    await h.installer.enable("com.openworklabs.station");

    const next = manifest({ version: "1.1.0" });
    const rebuilt = buildPackage(next, COMMIT_B);
    Object.assign(h.state, {
      manifest: next,
      archive: rebuilt.archive,
      manifestText: rebuilt.manifestText,
      commit: COMMIT_B,
      tag: "v1.1.0",
      assetName: rebuilt.assetName,
      assets: [{ name: rebuilt.assetName, browser_download_url: "https://objects/asset", size: rebuilt.archive.byteLength }],
    });
    const preview = await h.installer.preview({ repositoryUrl: REPO });
    await h.installer.update({
      appId: "com.openworklabs.station",
      candidateId: preview.candidateId,
      approvedPermissions: preview.manifest.permissions,
    });

    const rolled = await h.installer.rollback("com.openworklabs.station");
    expect(rolled.active.app_version).toBe("1.0.0");
    expect(rolled.previous).toBeNull();
    // Rolling back does not resume the app that was just misbehaving.
    expect(rolled.enablement).toBe("disabled");
    // The 1.0.0 files were retained, so rollback is real rather than a refetch.
    const files = await readdir(appInstallDir("com.openworklabs.station", "1.0.0", h.dataDir));
    expect(files).toContain("openwork.app.json");
  });

  test("rollback with nothing retained explains why it is unavailable", async () => {
    const h = await harness();
    await previewAndInstall(h);
    const error = await h.installer.rollback("com.openworklabs.station").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    if (error instanceof InstallError) expect(error.code).toBe("no_rollback_target");
  });
});

describe("crash quarantine", () => {
  test("a crash streak quarantines and disables the app", async () => {
    const h = await harness();
    await previewAndInstall(h);
    await h.installer.enable("com.openworklabs.station");

    await h.installer.recordCrash("com.openworklabs.station");
    await h.installer.recordCrash("com.openworklabs.station");
    const quarantined = await h.installer.recordCrash("com.openworklabs.station");
    expect(quarantined?.installation).toBe("quarantined");
    expect(quarantined?.enablement).toBe("disabled");
    await expect(h.installer.enable("com.openworklabs.station")).rejects.toThrow(InstallError);
  });

  test("crashes spread beyond the window do not accumulate into quarantine", async () => {
    const h = await harness();
    await previewAndInstall(h);
    await h.installer.enable("com.openworklabs.station");
    for (let index = 0; index < 5; index += 1) {
      await h.installer.recordCrash("com.openworklabs.station");
      h.now.value += 61_000;
    }
    const record = await h.store.get("com.openworklabs.station");
    expect(record?.installation).toBe("installed");
  });

  test("repair clears quarantine and leaves the app stopped", async () => {
    const h = await harness();
    await previewAndInstall(h);
    for (let index = 0; index < 3; index += 1) await h.installer.recordCrash("com.openworklabs.station");

    const repaired = await h.installer.repair("com.openworklabs.station", h.state.archive);
    expect(repaired.installation).toBe("installed");
    expect(repaired.enablement).toBe("disabled");
    expect(repaired.crash_count).toBe(0);
  });

  test("repair refuses a package that is not the installed one", async () => {
    const h = await harness();
    await previewAndInstall(h);
    const other = buildPackage(manifest({ version: "2.0.0" }), COMMIT_B);
    await expect(
      h.installer.repair("com.openworklabs.station", other.archive),
    ).rejects.toThrow(InstallError);
  });
});

describe("uninstall", () => {
  test("uninstall removes the registry entry and the installed files", async () => {
    const h = await harness();
    await previewAndInstall(h);
    const result = await h.installer.uninstall("com.openworklabs.station", { deleteData: false });
    expect(result.removed).toBe(true);
    expect(await h.store.get("com.openworklabs.station")).toBeNull();
    await expect(readdir(appInstallDir("com.openworklabs.station", "1.0.0", h.dataDir))).rejects.toThrow();
  });

  test("app data is kept or deleted according to the user's choice, and audited", async () => {
    const h = await harness();
    await previewAndInstall(h);
    const dataPath = appDataDir("com.openworklabs.station", h.dataDir);
    await Bun.write(join(dataPath, "state.json"), "{}");

    await h.installer.uninstall("com.openworklabs.station", { deleteData: false });
    expect(await readFile(join(dataPath, "state.json"), "utf8")).toBe("{}");
    let history = await h.store.auditHistory(20, "com.openworklabs.station");
    expect(history.some((row) => row.event === "app_data_retained")).toBe(true);

    await previewAndInstall(h);
    await h.installer.uninstall("com.openworklabs.station", { deleteData: true });
    await expect(readFile(join(dataPath, "state.json"), "utf8")).rejects.toThrow();
    history = await h.store.auditHistory(20, "com.openworklabs.station");
    expect(history.some((row) => row.event === "app_data_deleted")).toBe(true);
  });

  test("uninstalling something not installed is not an error", async () => {
    const h = await harness();
    expect(await h.installer.uninstall("com.nothing.here", { deleteData: true })).toEqual({
      removed: false,
    });
  });
});

describe("registry durability", () => {
  test("installed state survives a restart", async () => {
    const h = await harness();
    await previewAndInstall(h);
    await h.installer.enable("com.openworklabs.station");

    const reopened = new InstalledAppStore({ dataDir: h.dataDir });
    const record = await reopened.get("com.openworklabs.station");
    expect(record?.enablement).toBe("enabled");
    expect(record?.active.app_version).toBe("1.0.0");
  });

  test("a corrupted registry entry is dropped rather than trusted", async () => {
    const h = await harness();
    await previewAndInstall(h);
    const registryPath = join(h.dataDir, "apps", "installed.json");
    const raw = JSON.parse(await readFile(registryPath, "utf8")) as {
      apps: Array<Record<string, unknown>>;
    };
    raw.apps.push({ app_id: "com.tampered.app", enablement: "enabled" });
    await writeFile(registryPath, JSON.stringify(raw));

    const reopened = new InstalledAppStore({ dataDir: h.dataDir });
    const apps = await reopened.list();
    expect(apps.map((app) => app.app_id)).toEqual(["com.openworklabs.station"]);
    expect(reopened.rejectedOnLoad).toContain("com.tampered.app");
  });

  test("the audit trail records the full install lifecycle", async () => {
    const h = await harness();
    await previewAndInstall(h);
    await h.installer.enable("com.openworklabs.station");
    await h.installer.disable("com.openworklabs.station");
    const events = (await h.store.auditHistory(50, "com.openworklabs.station")).map((r) => r.event);
    expect(events).toContain("installed");
    expect(events).toContain("trust_granted");
    expect(events).toContain("enabled");
    expect(events).toContain("disabled");
  });
});

describe("candidate cache", () => {
  test("expired candidates and their archives are swept", async () => {
    const h = await harness();
    await h.installer.preview({ repositoryUrl: REPO });
    expect((await readdir(h.candidates.cacheDir)).length).toBe(1);

    h.now.value += 16 * 60_000;
    const swept = await h.candidates.sweep();
    expect(swept.candidates).toBe(1);
    expect(swept.archives).toBe(1);
    expect(await readdir(h.candidates.cacheDir)).toEqual([]);
  });

  test("a live candidate's archive is not swept", async () => {
    const h = await harness();
    await h.installer.preview({ repositoryUrl: REPO });
    h.now.value += 60_000;
    await h.candidates.sweep();
    expect((await readdir(h.candidates.cacheDir)).length).toBe(1);
  });
});
