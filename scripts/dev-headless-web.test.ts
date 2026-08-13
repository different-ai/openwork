import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  buildDetachedRespawnArgs,
  buildHeadlessCorsOrigins,
  buildHeadlessRuntimeManifest,
  buildHeadlessServerLaunch,
  buildOpenworkServerArgs,
  isHeadlessStackCommand,
  mergeHeadlessServerConfig,
  normalizeDenTarget,
  resolveHeadlessRuntimeManifestPath,
  resolveHeadlessServerConfigPath,
  resolveHeadlessTokens,
} from "./dev-headless-web-lib";

describe("dev-headless-web helpers", () => {
  test("isolates server config under tmp by default", () => {
    const cwd = "/repo/openwork";
    expect(resolveHeadlessServerConfigPath(cwd)).toBe(
      path.join(cwd, "tmp", "headless-server.json"),
    );
    expect(resolveHeadlessRuntimeManifestPath(cwd)).toBe(
      path.join(cwd, "tmp", "dev-headless-web.json"),
    );
    expect(
      resolveHeadlessServerConfigPath(cwd, "tmp/custom-server.json"),
    ).toBe(path.join(cwd, "tmp", "custom-server.json"));
  });

  test("bootstraps a fresh config with the workspace registered and authorized", () => {
    expect(mergeHeadlessServerConfig(null, "/Users/me/project")).toEqual({
      authorizedRoots: ["/Users/me/project"],
      workspaces: [{ path: "/Users/me/project" }],
    });
  });

  test("relaunch merge preserves server-persisted workspaces and roots", () => {
    const persistedByServer = JSON.stringify({
      authorizedRoots: ["/Users/me/project", "/Users/me/added-folder"],
      workspaces: [
        { id: "ws_added", path: "/Users/me/added-folder", name: "added-folder" },
        { id: "ws_main", path: "/Users/me/project", name: "project" },
      ],
      readOnly: false,
    });
    expect(mergeHeadlessServerConfig(persistedByServer, "/Users/me/project")).toEqual({
      authorizedRoots: ["/Users/me/project", "/Users/me/added-folder"],
      workspaces: [
        { id: "ws_added", path: "/Users/me/added-folder", name: "added-folder" },
        { id: "ws_main", path: "/Users/me/project", name: "project" },
      ],
      readOnly: false,
    });
  });

  test("merge registers the workspace when missing and survives corrupt config", () => {
    const missingWorkspace = JSON.stringify({
      authorizedRoots: ["/Users/me/other"],
      workspaces: [{ path: "/Users/me/other" }],
    });
    expect(mergeHeadlessServerConfig(missingWorkspace, "/Users/me/project")).toEqual({
      authorizedRoots: ["/Users/me/other", "/Users/me/project"],
      workspaces: [{ path: "/Users/me/other" }, { path: "/Users/me/project" }],
    });
    expect(mergeHeadlessServerConfig("not-json{{", "/Users/me/project")).toEqual({
      authorizedRoots: ["/Users/me/project"],
      workspaces: [{ path: "/Users/me/project" }],
    });
  });

  test("tokens are reused from the previous manifest across relaunches", () => {
    expect(
      resolveHeadlessTokens({
        envToken: undefined,
        envHostToken: undefined,
        previous: { token: "kept-token", hostToken: "kept-host-token" },
        generate: () => "fresh",
      }),
    ).toEqual({ token: "kept-token", hostToken: "kept-host-token" });
    expect(
      resolveHeadlessTokens({
        envToken: "env-token",
        envHostToken: undefined,
        previous: { token: "kept-token", hostToken: "kept-host-token" },
        generate: () => "fresh",
      }),
    ).toEqual({ token: "env-token", hostToken: "kept-host-token" });
    // `--replace` drops the previous manifest so leaked credentials die with
    // the old process. `--keep-tokens` is the opt-in that passes previous.
    expect(
      resolveHeadlessTokens({
        envToken: undefined,
        envHostToken: undefined,
        previous: null,
        generate: () => "fresh",
      }),
    ).toEqual({ token: "fresh", hostToken: "fresh" });
  });

  test("server args use --config only, never --workspace (would drop persisted workspaces)", () => {
    const args = buildOpenworkServerArgs({
      host: "127.0.0.1",
      port: 8787,
      configPath: "/repo/tmp/headless-server.json",
      corsOrigins: ["http://127.0.0.1:5178"],
    });
    expect(args.slice(0, 2)).toEqual([
      "--config",
      "/repo/tmp/headless-server.json",
    ]);
    expect(args).not.toContain("--workspace");
    expect(args).not.toContain("--token");
    expect(args).not.toContain("--host-token");
  });

  test("server launch always uses current source instead of compiled output", () => {
    expect(buildHeadlessServerLaunch("/repo/openwork", ["--port", "8787"])).toEqual({
      command: "bun",
      args: [
        "--conditions=development",
        path.join("/repo/openwork", "apps/server/src/cli.ts"),
        "--port",
        "8787",
      ],
    });
  });

  test("CORS is pinned to the web app origins, never wildcarded", () => {
    const corsOrigins = buildHeadlessCorsOrigins({
      webUrl: "http://127.0.0.1:5178",
      webPort: 5178,
    });
    expect(corsOrigins).toEqual([
      "http://127.0.0.1:5178",
      "http://localhost:5178",
    ]);
    // A public host still gets its own origin alongside the loopback ones.
    expect(
      buildHeadlessCorsOrigins({ webUrl: "http://dev.local:5178", webPort: 5178 }),
    ).toEqual([
      "http://dev.local:5178",
      "http://127.0.0.1:5178",
      "http://localhost:5178",
    ]);

    const args = buildOpenworkServerArgs({
      host: "127.0.0.1",
      port: 8787,
      configPath: "/repo/tmp/headless-server.json",
      corsOrigins,
    });
    expect(args[args.indexOf("--cors") + 1]).toBe(
      "http://127.0.0.1:5178,http://localhost:5178",
    );
    expect(args).not.toContain("*");
  });

  test("runtime manifest carries agent-facing local-server fields", () => {
    const manifest = buildHeadlessRuntimeManifest({
      webUrl: "http://127.0.0.1:5178",
      openworkUrl: "http://127.0.0.1:8778",
      workspace: "/Users/me/project",
      token: "client-token",
      hostToken: "host-token",
      serverConfigPath: "/repo/tmp/headless-server.json",
      runtimeManifestPath: "/repo/tmp/dev-headless-web.json",
      webLogPath: "/repo/tmp/dev-web.log",
      headlessLogPath: "/repo/tmp/dev-headless.log",
      denTarget: "https://app.openworklabs.com",
      pid: 42,
      webPid: 43,
      openworkServerPid: 44,
      startedAt: "2026-08-12T00:00:00.000Z",
    });

    expect(manifest.mode).toBe("local-server");
    expect(manifest.healthUrl).toBe("http://127.0.0.1:8778/health");
    expect(manifest.denTarget).toBe("https://app.openworklabs.com");
    expect(manifest.denApiUrl).toBe("http://127.0.0.1:5178/api/den");
    expect(manifest.token).toBe("client-token");
    expect(manifest.notes).toContain("same-origin");
    expect(manifest.pid).toBe(42);
    expect(manifest.pids).toEqual({ launcher: 42, web: 43, openworkServer: 44 });
  });

  test("manifest omits Den fields when the Den wiring is disabled", () => {
    const manifest = buildHeadlessRuntimeManifest({
      webUrl: "http://127.0.0.1:5178",
      openworkUrl: "http://127.0.0.1:8778",
      workspace: "/Users/me/project",
      token: "t",
      hostToken: "h",
      serverConfigPath: "/repo/tmp/headless-server.json",
      runtimeManifestPath: "/repo/tmp/dev-headless-web.json",
      webLogPath: "/repo/tmp/dev-web.log",
      headlessLogPath: "/repo/tmp/dev-headless.log",
      denTarget: null,
    });
    expect(manifest.denTarget).toBeNull();
    expect(manifest.denApiUrl).toBeNull();
  });

  test("normalizes Den targets to origins", () => {
    expect(normalizeDenTarget("https://app.openworklabs.com/api/den")).toBe(
      "https://app.openworklabs.com",
    );
    expect(normalizeDenTarget("http://127.0.0.1:3005")).toBe(
      "http://127.0.0.1:3005",
    );
    expect(normalizeDenTarget(undefined)).toBe("https://app.openworklabs.com");
  });

  test("detached respawn forwards args except --detach", () => {
    expect(buildDetachedRespawnArgs(["--detach", "--replace", "--silent"])).toEqual([
      "--replace",
      "--silent",
    ]);
    expect(buildDetachedRespawnArgs(["--detach"])).toEqual([]);
  });

  test("stale-pid cleanup only targets processes from this stack", () => {
    expect(isHeadlessStackCommand("bun scripts/dev-headless-web.ts")).toBe(true);
    expect(
      isHeadlessStackCommand("/repo/apps/server/dist/bin/openwork-server --config tmp/headless-server.json"),
    ).toBe(true);
    expect(
      isHeadlessStackCommand("bun --conditions=development /repo/apps/server/src/cli.ts --config tmp/headless-server.json"),
    ).toBe(true);
    expect(isHeadlessStackCommand("node vite --host 127.0.0.1 --port 5178")).toBe(true);
    expect(isHeadlessStackCommand("/usr/bin/some-unrelated-daemon")).toBe(false);
    expect(isHeadlessStackCommand("ssh user@host")).toBe(false);
  });
});
