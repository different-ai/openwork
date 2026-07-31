import { describe, expect, test } from "bun:test";

import type { InstalledAppRecord } from "@openwork/app-contract";

import type { AppPreview } from "@/react-app/domains/apps/apps-client";
import { lifecycleGuidance, lifecyclePhase } from "@/react-app/domains/apps/apps-client";
import {
  approvedPermissions,
  describeDelta,
  groupPermissions,
  initialInstallState,
  reduceInstall,
  reviewIsLive,
} from "@/react-app/domains/apps/install-flow";

const NOW = 1_700_000_000_000;

function preview(overrides: Partial<AppPreview> = {}): AppPreview {
  return {
    candidateId: "cand-1",
    expiresAt: NOW + 15 * 60_000,
    manifest: {
      manifest_version: 1,
      id: "com.openworklabs.station",
      name: "OpenWork Station",
      description: "Ambient assistant.",
      version: "1.0.0",
      publisher: { name: "OpenWork Labs" },
      repository: "https://github.com/different-ai/openwork-station",
      license: "MIT",
      icons: { default: "assets/icon.svg" },
      engines: { openwork: { min: "0.1.0" }, app_api: { min: "1.0.0" } },
      platforms: [{ os: "darwin", arch: ["arm64"] }],
      distribution: {
        type: "github-release",
        repository: "https://github.com/different-ai/openwork-station",
        asset: "station-{version}.owapp",
      },
      entrypoints: { surfaces: {} },
      contributions: [],
      permissions: [],
      environment: { required: [], optional: [] },
      privacy: {
        summary: "…",
        data_handled: ["none"],
        retention: { policy: "none", description: "…" },
        third_parties: [],
      },
      update: { channel: "github-release", rollback_supported: true },
    },
    source: {
      repository: "https://github.com/different-ai/openwork-station",
      releaseTag: "v1.0.0",
      commit: "c".repeat(40),
      assetName: "station-1.0.0.owapp",
      publishedAt: null,
      prerelease: false,
    },
    archiveDigest: `sha256:${"a".repeat(64)}`,
    permissions: [
      {
        permission: { id: "audio.microphone", reason: "listen" },
        risk: "critical",
        label: "Use the microphone",
        reason: "listen",
        detail: null,
      },
      {
        permission: { id: "storage.app", reason: "cache", quota_bytes: 1024 },
        risk: "low",
        label: "Store its own data",
        reason: "cache",
        detail: "up to 1 KB",
      },
    ],
    environment: [],
    contributions: [],
    compatible: true,
    warnings: [],
    installed: null,
    ...overrides,
  };
}

function record(overrides: Partial<InstalledAppRecord> = {}): InstalledAppRecord {
  return {
    app_id: "com.openworklabs.station",
    installation: "installed",
    setup: "ready",
    enablement: "disabled",
    compatibility: "compatible",
    active: {
      app_version: "1.0.0",
      archive_digest: `sha256:${"a".repeat(64)}`,
      manifest_digest: `sha256:${"b".repeat(64)}`,
      source: {
        repository: "https://github.com/different-ai/openwork-station",
        release_tag: "v1.0.0",
        commit: "c".repeat(40),
      },
      directory: "1.0.0",
      installed_at: 0,
      permissions: [],
    },
    previous: null,
    pending: null,
    granted_permissions: [],
    crash_count: 0,
    trusted_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("install flow", () => {
  test("the happy path runs idle → resolving → review → installing → installed", () => {
    let state = initialInstallState();
    state = reduceInstall(state, { type: "submit", repositoryUrl: "https://github.com/a/b" }, NOW);
    expect(state.step).toBe("resolving");
    state = reduceInstall(state, { type: "resolved", preview: preview() }, NOW);
    expect(state.step).toBe("review");
    state = reduceInstall(state, { type: "confirm" }, NOW);
    expect(state.step).toBe("installing");
    state = reduceInstall(state, { type: "installed", record: record() }, NOW);
    expect(state.step).toBe("installed");
  });

  test("an app with an unconfigured requirement stops at setup, not at running", () => {
    let state = reduceInstall(
      initialInstallState(),
      { type: "submit", repositoryUrl: "https://github.com/a/b" },
      NOW,
    );
    const withRequirement = preview({
      environment: [
        { key: "OPENAI_API_KEY", label: "OpenAI API key", required: true, configured: false },
      ],
    });
    state = reduceInstall(state, { type: "resolved", preview: withRequirement }, NOW);
    state = reduceInstall(state, { type: "confirm" }, NOW);
    state = reduceInstall(state, { type: "installed", record: record() }, NOW);
    expect(state.step).toBe("setup");
  });

  test("confirming an expired review fails instead of installing", () => {
    let state = reduceInstall(
      initialInstallState(),
      { type: "submit", repositoryUrl: "https://github.com/a/b" },
      NOW,
    );
    state = reduceInstall(state, { type: "resolved", preview: preview() }, NOW);
    state = reduceInstall(state, { type: "confirm" }, NOW + 16 * 60_000);
    expect(state.step).toBe("failed");
    if (state.step === "failed") expect(state.message).toContain("expired");
  });

  test("an incompatible app cannot be confirmed", () => {
    let state = reduceInstall(
      initialInstallState(),
      { type: "submit", repositoryUrl: "https://github.com/a/b" },
      NOW,
    );
    state = reduceInstall(
      state,
      { type: "resolved", preview: preview({ compatible: false, warnings: ["needs win32"] }) },
      NOW,
    );
    state = reduceInstall(state, { type: "confirm" }, NOW);
    expect(state.step).toBe("failed");
  });

  test("a resolve landing after cancel does not reopen the review", () => {
    let state = reduceInstall(
      initialInstallState(),
      { type: "submit", repositoryUrl: "https://github.com/a/b" },
      NOW,
    );
    state = reduceInstall(state, { type: "cancel" }, NOW);
    state = reduceInstall(state, { type: "resolved", preview: preview() }, NOW);
    expect(state.step).toBe("idle");
  });

  test("confirm outside review does nothing", () => {
    expect(reduceInstall(initialInstallState(), { type: "confirm" }, NOW).step).toBe("idle");
  });

  test("an install result arriving outside the installing step is ignored", () => {
    const state = reduceInstall(initialInstallState(), { type: "installed", record: record() }, NOW);
    expect(state.step).toBe("idle");
  });

  test("the submitted permissions are exactly the ones displayed", () => {
    const shown = preview();
    expect(approvedPermissions(shown)).toEqual(shown.permissions.map((entry) => entry.permission));
  });

  test("permissions are grouped critical-first and empty bands are dropped", () => {
    const groups = groupPermissions(preview());
    expect(groups.map((group) => group.risk)).toEqual(["critical", "low"]);
    expect(groups[0]?.items[0]?.permission.id).toBe("audio.microphone");
  });

  test("review liveness tracks the candidate expiry", () => {
    const shown = preview();
    expect(reviewIsLive(shown, NOW)).toBe(true);
    expect(reviewIsLive(shown, shown.expiresAt)).toBe(false);
  });
});

describe("update descriptions", () => {
  test("an update that adds something says what it adds", () => {
    expect(
      describeDelta({
        entries: [
          { change: "added", permission: { id: "audio.microphone" } },
          { change: "removed", permission: { id: "storage.app" } },
        ],
      }),
    ).toBe("This update also wants: audio.microphone.");
  });

  test("an update that only gives something up says so", () => {
    expect(
      describeDelta({ entries: [{ change: "removed", permission: { id: "storage.app" } }] }),
    ).toBe("This update gives up: storage.app.");
  });

  test("an update with no permission change says nothing is new", () => {
    expect(describeDelta({ entries: [] })).toBe("This update asks for nothing new.");
  });
});

describe("lifecycle phrasing", () => {
  test("each state maps to a phase the user can act on", () => {
    expect(lifecyclePhase(record())).toBe("disabled");
    expect(lifecyclePhase(record({ enablement: "enabled" }))).toBe("enabled");
    expect(lifecyclePhase(record({ setup: "setup_required" }))).toBe("needs_setup");
    expect(lifecyclePhase(record({ installation: "quarantined" }))).toBe("quarantined");
    expect(lifecyclePhase(record({ installation: "update_pending_review" }))).toBe(
      "update_pending_review",
    );
    expect(lifecyclePhase(record({ compatibility: "engine_incompatible" }))).toBe("incompatible");
    expect(lifecyclePhase(record({ installation: "corrupt" }))).toBe("corrupt");
  });

  test("an installed app is described as ready but not running", () => {
    expect(lifecycleGuidance(record())).toContain("Turn it on");
  });

  test("every phase has guidance", () => {
    for (const overrides of [
      {},
      { enablement: "enabled" as const },
      { setup: "setup_required" as const },
      { installation: "quarantined" as const },
      { installation: "update_pending_review" as const },
      { compatibility: "engine_incompatible" as const },
      { installation: "corrupt" as const },
    ]) {
      expect(lifecycleGuidance(record(overrides)).length).toBeGreaterThan(0);
    }
  });
});
