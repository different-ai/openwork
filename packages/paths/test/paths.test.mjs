import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  desktopBootstrapPath,
  globalOpencodeConfigDir,
  legacyDesktopBootstrapPath,
  MAX_CONFIG_ROOT_LENGTH,
  normalizeWorkspaceRootPath,
  opencodeDbCandidates,
  openworkEnvStorePath,
  openworkServerConfigPath,
  resolveGlobalOpencodeConfigPath,
  resolveWorkspaceOpencodeConfigPath,
  workspaceOpencodeConfigCandidates,
} from "../index.mjs";

async function withTempDir(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-paths-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("workspace root paths", () => {
  test("normalizes valid Windows verbatim drive and UNC paths cross-platform", () => {
    const opts = { platform: "win32" };
    expect(normalizeWorkspaceRootPath("\\\\?\\C:\\Users\\Ada\\Workspace", opts))
      .toBe("C:\\Users\\Ada\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\?\\C:\\", opts)).toBe("C:\\");
    expect(normalizeWorkspaceRootPath("//?/UNC/server/share/Workspace", opts))
      .toBe("\\\\server\\share\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\?\\UNC\\server\\share", opts))
      .toBe("\\\\server\\share");
  });

  test("preserves valid normal drives and UNC shares without checking availability", () => {
    const opts = { platform: "win32" };
    expect(normalizeWorkspaceRootPath("Z:\\Disconnected\\Workspace", opts))
      .toBe("Z:\\Disconnected\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\offline-server\\share\\Workspace", opts))
      .toBe("\\\\offline-server\\share\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\offline-server\\pipe\\Workspace", opts))
      .toBe("\\\\offline-server\\pipe\\Workspace");
  });

  test("rejects Win32 device namespace roots", () => {
    const opts = { platform: "win32" };
    for (const value of [
      "\\\\.\\pipe\\openwork",
      "//./PIPE/openwork",
      "\\\\.\\PhysicalDrive0",
      "\\\\?\\UNC\\.\\pipe\\openwork",
      "\\\\?\\UNC\\?\\PhysicalDrive0",
    ]) {
      expect(() => normalizeWorkspaceRootPath(value, opts)).toThrow("Invalid Windows workspace root");
    }
  });

  test("rejects incomplete Windows drive and UNC roots", () => {
    const opts = { platform: "win32" };
    for (const value of [
      "C:",
      "\\\\?\\",
      "\\\\?\\C:",
      "\\\\?\\C:Workspace",
      "\\\\?\\UNC",
      "\\\\?\\UNC\\server",
      "\\\\server",
    ]) {
      expect(() => normalizeWorkspaceRootPath(value, opts)).toThrow("Invalid Windows workspace root");
    }
  });

  test("applies Windows validation only when Windows is injected", () => {
    expect(normalizeWorkspaceRootPath("\\\\?\\C:", { platform: "linux" })).toBe("\\\\?\\C:");
  });
});

describe("OpenCode database paths", () => {
  test("uses the production channel name and honors explicit overrides", () => {
    expect(opencodeDbCandidates({
      env: {},
      homeDir: "/Users/ada",
      platform: "darwin",
      defaultChannel: "latest",
    })).toContain("/Users/ada/Library/Application Support/opencode/opencode.db");
    expect(opencodeDbCandidates({
      env: { OPENCODE_CHANNEL: "preview" },
      dataDirs: ["/tmp/opencode"],
      homeDir: "/Users/ada",
      platform: "darwin",
    })[0]).toBe("/tmp/opencode/opencode-preview.db");
    expect(opencodeDbCandidates({
      env: { OPENCODE_DB: "/tmp/production.db" },
      homeDir: "/Users/ada",
      platform: "darwin",
    })).toEqual(["/tmp/production.db"]);
  });
});

describe("openwork server config paths", () => {
  test("uses APPDATA on Windows", () => {
    expect(openworkServerConfigPath({
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      homeDir: "C:\\Users\\Ada",
      platform: "win32",
    })).toBe("C:\\Users\\Ada\\AppData\\Roaming\\openwork\\server.json");
  });

  test("uses XDG_CONFIG_HOME on Unix", () => {
    expect(openworkServerConfigPath({
      env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/xdg/openwork/server.json");
  });

  test("falls back to ~/.config", () => {
    expect(openworkServerConfigPath({ env: {}, homeDir: "/home/ada", platform: "linux" }))
      .toBe("/home/ada/.config/openwork/server.json");
  });

  test("honors OPENWORK_SERVER_CONFIG", () => {
    expect(openworkServerConfigPath({
      env: { OPENWORK_SERVER_CONFIG: "/tmp/openwork/server.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/openwork/server.json");
  });
});

describe("openwork env store and desktop bootstrap paths", () => {
  test("honors OPENWORK_ENV_STORE", () => {
    expect(openworkEnvStorePath({
      env: { OPENWORK_ENV_STORE: "/tmp/openwork/env.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/openwork/env.json");
  });

  test("uses the same openwork config layout for env.json", () => {
    expect(openworkEnvStorePath({
      env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/xdg/openwork/env.json");
  });

  test("honors OPENWORK_DESKTOP_BOOTSTRAP_PATH", () => {
    expect(desktopBootstrapPath({
      env: { OPENWORK_DESKTOP_BOOTSTRAP_PATH: "/tmp/bootstrap.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/bootstrap.json");
  });

  test("preserves dev-data desktop bootstrap path when userDataDir is injected", () => {
    expect(desktopBootstrapPath({
      env: { OPENWORK_DEV_MODE: "1" },
      homeDir: "/Users/ada",
      platform: "darwin",
      userDataDir: "/tmp/openwork-userdata",
    })).toBe("/tmp/openwork-userdata/openwork-dev-data/home/.config/openwork/desktop-bootstrap.json");
  });

  test("resolves the legacy desktop bootstrap path from the chosen home", () => {
    expect(legacyDesktopBootstrapPath({ env: {}, homeDir: "/Users/ada", platform: "darwin" }))
      .toBe("/Users/ada/.config/openwork/desktop-bootstrap.json");
  });
});

describe("global OpenCode config paths", () => {
  test("accepts safe OPENCODE_CONFIG_DIR as the config directory", async () => {
    await withTempDir(async (root) => {
      const opencodeConfigDir = path.join(root, "explicit-opencode");
      await mkdir(opencodeConfigDir, { recursive: true });
      const json = path.join(opencodeConfigDir, "opencode.json");
      await writeFile(json, "{}", "utf8");

      const opts = {
        env: { OPENCODE_CONFIG_DIR: opencodeConfigDir, XDG_CONFIG_HOME: path.join(root, "xdg") },
        homeDir: path.join(root, "home"),
        platform: "linux",
      };
      expect(globalOpencodeConfigDir(opts)).toBe(opencodeConfigDir);
      expect(resolveGlobalOpencodeConfigPath(opts)).toBe(json);
    });
  });

  test("prefers opencode.jsonc over opencode.json and falls back to jsonc", async () => {
    await withTempDir(async (root) => {
      const dir = path.join(root, "xdg", "opencode");
      await mkdir(dir, { recursive: true });
      const opts = { env: { XDG_CONFIG_HOME: path.join(root, "xdg") }, homeDir: path.join(root, "home"), platform: "linux" };
      const jsonc = path.join(dir, "opencode.jsonc");
      const json = path.join(dir, "opencode.json");

      expect(resolveGlobalOpencodeConfigPath(opts)).toBe(jsonc);
      await writeFile(json, "{}", "utf8");
      expect(resolveGlobalOpencodeConfigPath(opts)).toBe(json);
      await writeFile(jsonc, "{}", "utf8");
      expect(resolveGlobalOpencodeConfigPath(opts)).toBe(jsonc);
    });
  });

  test("rejects relative OPENCODE_CONFIG_DIR", () => {
    const opts = {
      env: { OPENCODE_CONFIG_DIR: "relative/opencode", XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalOpencodeConfigDir(opts)).toBe("/tmp/xdg/opencode");
  });

  test("rejects over-long OPENCODE_CONFIG_DIR", () => {
    const opts = {
      env: { OPENCODE_CONFIG_DIR: `/${"a".repeat(MAX_CONFIG_ROOT_LENGTH)}`, XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalOpencodeConfigDir(opts)).toBe("/tmp/xdg/opencode");
  });

  test("rejects forbidden control characters in OPENCODE_CONFIG_DIR", () => {
    const opts = {
      env: { OPENCODE_CONFIG_DIR: "/tmp/opencode\n", XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalOpencodeConfigDir(opts)).toBe("/tmp/xdg/opencode");
  });
});

describe("workspace OpenCode config paths", () => {
  test("returns the four server candidates in order", () => {
    expect(workspaceOpencodeConfigCandidates("/repo/workspace")).toEqual([
      "/repo/workspace/opencode.jsonc",
      "/repo/workspace/opencode.json",
      "/repo/workspace/.opencode/opencode.jsonc",
      "/repo/workspace/.opencode/opencode.json",
    ]);
  });

  test("resolves the first existing workspace candidate", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, ".opencode"), { recursive: true });
      const hiddenJsonc = path.join(root, ".opencode", "opencode.jsonc");
      const hiddenJson = path.join(root, ".opencode", "opencode.json");
      await writeFile(hiddenJson, "{}", "utf8");
      expect(resolveWorkspaceOpencodeConfigPath(root)).toBe(hiddenJson);
      await writeFile(hiddenJsonc, "{}", "utf8");
      expect(resolveWorkspaceOpencodeConfigPath(root)).toBe(hiddenJsonc);
    });
  });
});
