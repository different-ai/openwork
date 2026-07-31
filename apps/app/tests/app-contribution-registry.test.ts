import { describe, expect, test } from "bun:test";

import type { AppManifest, InstalledAppRecord } from "@openwork/app-contract";

import {
  buildRail,
  contributesNow,
  resolveAllowedHosts,
  resolveRuntimePlan,
  resolveShortcuts,
  resolveSurfaces,
  type BuiltInRailItem,
  type InstalledApp,
} from "@/react-app/domains/apps/contribution-registry";

const BUILT_INS: BuiltInRailItem[] = [
  { id: "browser", label: "Browser", icon: "/browser.svg", order: 10, visible: true },
  { id: "voice", label: "Voice Mode", icon: "/voice.svg", order: 20, visible: true },
  { id: "hidden", label: "Hidden", icon: "/x.svg", order: 5, visible: false },
];

function manifest(appId: string, overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    manifest_version: 1,
    id: appId,
    name: "Station",
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
    entrypoints: { background: "dist/bg.js", surfaces: { main: "dist/index.html" } },
    contributions: [
      {
        type: "surface",
        id: "main",
        entrypoint: "main",
        presentation: "floating",
        default_size: { width: 360, height: 220 },
        anchor: "right-center",
      },
      {
        type: "right_sidebar_item",
        id: "rail",
        label: "Station",
        surface: "main",
        icon: "assets/icon.svg",
        order: 200,
      },
      { type: "status", id: "dot", target: "rail", display: "dot" },
      { type: "background", id: "agent", entrypoint: "background" },
      { type: "command", id: "toggle", title: "Toggle" },
      { type: "shortcut", id: "toggle-key", command: "toggle", global: true },
    ],
    permissions: [],
    environment: { required: [], optional: [] },
    privacy: {
      summary: "…",
      data_handled: ["none"],
      retention: { policy: "none", description: "…" },
      third_parties: [],
    },
    update: { channel: "github-release", rollback_supported: true },
    ...overrides,
  };
}

function record(appId: string, overrides: Partial<InstalledAppRecord> = {}): InstalledAppRecord {
  return {
    app_id: appId,
    installation: "installed",
    setup: "ready",
    enablement: "enabled",
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
    granted_permissions: [
      { id: "desktop.floatingSurface", reason: "island", always_on_top: true },
      { id: "runtime.background.continuous", reason: "watch" },
      { id: "network.host", reason: "model", hosts: ["api.openai.com"] },
      { id: "audio.microphone", reason: "listen" },
      {
        id: "desktop.globalShortcut",
        reason: "toggle",
        shortcuts: [{ id: "toggle-key", default_accelerator: "CommandOrControl+Shift+Space" }],
      },
    ],
    crash_count: 0,
    trusted_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function app(appId = "com.openworklabs.station", overrides: Partial<InstalledApp> = {}): InstalledApp {
  return { record: record(appId), manifest: manifest(appId), ...overrides };
}

describe("what may contribute", () => {
  test("a ready, enabled app contributes", () => {
    expect(contributesNow(app())).toBe(true);
  });

  test("an installed but disabled app contributes nothing", () => {
    const disabled = app("com.a.b", { record: record("com.a.b", { enablement: "disabled" }) });
    expect(contributesNow(disabled)).toBe(false);
    expect(buildRail(BUILT_INS, [disabled]).filter((item) => item.source === "app")).toEqual([]);
  });

  test("an app awaiting setup contributes nothing", () => {
    const pending = app("com.a.b", { record: record("com.a.b", { setup: "setup_required" }) });
    expect(contributesNow(pending)).toBe(false);
  });

  test("a quarantined app contributes nothing", () => {
    const broken = app("com.a.b", { record: record("com.a.b", { installation: "quarantined" }) });
    expect(contributesNow(broken)).toBe(false);
  });

  test("an incompatible app contributes nothing", () => {
    const stale = app("com.a.b", {
      record: record("com.a.b", { compatibility: "engine_incompatible" }),
    });
    expect(contributesNow(stale)).toBe(false);
  });

  test("an app whose package could not be read contributes nothing", () => {
    expect(contributesNow({ record: record("com.a.b"), manifest: null })).toBe(false);
  });
});

describe("right rail", () => {
  test("built-ins keep their order and stay ahead of installed apps", () => {
    const rail = buildRail(BUILT_INS, [app()]);
    expect(rail.map((item) => item.key)).toEqual(["browser", "voice", "com.openworklabs.station/rail"]);
  });

  test("a hidden built-in is not rendered", () => {
    expect(buildRail(BUILT_INS, []).some((item) => item.key === "hidden")).toBe(false);
  });

  test("registration keys are namespaced, so two apps cannot collide", () => {
    const a = app("com.a.app");
    const b = app("com.b.app");
    const rail = buildRail([], [a, b]);
    expect(rail.map((item) => item.key)).toEqual(["com.a.app/rail", "com.b.app/rail"]);
    expect(new Set(rail.map((item) => item.key)).size).toBe(2);
  });

  test("an installed app cannot claim a built-in key", () => {
    const rail = buildRail(BUILT_INS, [app()]);
    const builtInKeys = new Set(BUILT_INS.map((entry) => entry.id));
    for (const item of rail.filter((entry) => entry.source === "app")) {
      expect(builtInKeys.has(item.key)).toBe(false);
      expect(item.key).toContain("/");
    }
  });

  test("ordering is deterministic when two apps declare the same order", () => {
    const first = buildRail([], [app("com.b.app"), app("com.a.app")]);
    const second = buildRail([], [app("com.a.app"), app("com.b.app")]);
    expect(first.map((item) => item.key)).toEqual(second.map((item) => item.key));
    expect(first.map((item) => item.key)).toEqual(["com.a.app/rail", "com.b.app/rail"]);
  });

  test("declared order wins over app id", () => {
    const early = app("com.z.app", {
      manifest: manifest("com.z.app", {
        contributions: manifest("com.z.app").contributions.map((contribution) =>
          contribution.type === "right_sidebar_item" ? { ...contribution, order: 1 } : contribution,
        ),
      }),
    });
    const rail = buildRail([], [app("com.a.app"), early]);
    expect(rail[0]?.ownerId).toBe("com.z.app");
  });

  test("icons resolve through the app protocol, never the host origin", () => {
    const rail = buildRail([], [app()]);
    expect(rail[0]?.icon).toBe("openwork-app://com.openworklabs.station/assets/icon.svg");
  });

  test("a live status value is attached to its rail item", () => {
    const withStatus = app("com.a.b", { status: { dot: { kind: "dot", tone: "active" } } });
    expect(buildRail([], [withStatus])[0]?.status).toEqual({ kind: "dot", tone: "active" });
  });

  test("revoking the floating-surface permission removes the rail item", () => {
    const revoked = app("com.a.b", {
      record: record("com.a.b", {
        granted_permissions: record("com.a.b").granted_permissions.filter(
          (permission) => permission.id !== "desktop.floatingSurface",
        ),
      }),
    });
    expect(buildRail(BUILT_INS, [revoked]).filter((item) => item.source === "app")).toEqual([]);
  });

  test("a rail item pointing at an undeclared surface is not rendered", () => {
    const dangling = app("com.a.b", {
      manifest: manifest("com.a.b", {
        contributions: manifest("com.a.b").contributions.filter(
          (contribution) => contribution.type !== "surface",
        ),
      }),
    });
    expect(buildRail([], [dangling])).toEqual([]);
  });
});

describe("surfaces", () => {
  test("a floating surface resolves its entrypoint path and always-on-top", () => {
    expect(resolveSurfaces(app())).toEqual([
      {
        id: "main",
        entrypoint: "dist/index.html",
        presentation: "floating",
        defaultSize: { width: 360, height: 220 },
        anchor: "right-center",
        alwaysOnTop: true,
      },
    ]);
  });

  test("without always_on_top granted, the surface is not pinned above other windows", () => {
    const notPinned = app("com.a.b", {
      record: record("com.a.b", {
        granted_permissions: record("com.a.b").granted_permissions.map((permission) =>
          permission.id === "desktop.floatingSurface"
            ? { ...permission, always_on_top: false }
            : permission,
        ),
      }),
    });
    expect(resolveSurfaces(notPinned)[0]?.alwaysOnTop).toBe(false);
  });

  test("a disabled app resolves no surfaces", () => {
    expect(resolveSurfaces(app("com.a.b", { record: record("com.a.b", { enablement: "disabled" }) }))).toEqual(
      [],
    );
  });
});

describe("shortcuts", () => {
  test("a granted global shortcut is registered", () => {
    const { registrations, conflicts } = resolveShortcuts([app()]);
    expect(registrations).toEqual([
      {
        key: "com.openworklabs.station/toggle-key",
        appId: "com.openworklabs.station",
        shortcutId: "toggle-key",
        accelerator: "CommandOrControl+Shift+Space",
        commandId: "toggle",
      },
    ]);
    expect(conflicts).toEqual([]);
  });

  test("a shortcut without its permission is not registered", () => {
    const noPermission = app("com.a.b", {
      record: record("com.a.b", {
        granted_permissions: record("com.a.b").granted_permissions.filter(
          (permission) => permission.id !== "desktop.globalShortcut",
        ),
      }),
    });
    expect(resolveShortcuts([noPermission]).registrations).toEqual([]);
  });

  test("a conflict is resolved deterministically and reported", () => {
    const a = app("com.a.app");
    const b = app("com.b.app");
    const first = resolveShortcuts([b, a]);
    const second = resolveShortcuts([a, b]);
    expect(first.registrations.map((entry) => entry.appId)).toEqual(["com.a.app"]);
    expect(second.registrations.map((entry) => entry.appId)).toEqual(["com.a.app"]);
    expect(first.conflicts).toEqual([
      {
        accelerator: "CommandOrControl+Shift+Space",
        winner: "com.a.app",
        losers: ["com.b.app"],
      },
    ]);
  });

  test("a disabled app releases its shortcut", () => {
    const disabled = app("com.a.b", { record: record("com.a.b", { enablement: "disabled" }) });
    expect(resolveShortcuts([disabled]).registrations).toEqual([]);
  });
});

describe("runtime plan", () => {
  test("the plan carries only what the app was granted", () => {
    const plan = resolveRuntimePlan([app()]);
    expect(plan.get("com.openworklabs.station")).toEqual({
      allowedHosts: ["api.openai.com"],
      allowMicrophone: true,
      shortcuts: [{ id: "toggle-key", accelerator: "CommandOrControl+Shift+Space" }],
    });
  });

  test("revoking network access empties the allowed hosts", () => {
    const revoked = app("com.a.b", {
      record: record("com.a.b", {
        granted_permissions: record("com.a.b").granted_permissions.filter(
          (permission) => permission.id !== "network.host",
        ),
      }),
    });
    expect(resolveAllowedHosts(revoked)).toEqual([]);
    expect(resolveRuntimePlan([revoked]).get("com.a.b")?.allowedHosts).toEqual([]);
  });

  test("a disabled app simply disappears from the plan, which is how it stops", () => {
    const disabled = app("com.a.b", { record: record("com.a.b", { enablement: "disabled" }) });
    expect(resolveRuntimePlan([disabled]).has("com.a.b")).toBe(false);
  });

  test("an uninstalled app is absent from the plan", () => {
    expect(resolveRuntimePlan([]).size).toBe(0);
  });
});
