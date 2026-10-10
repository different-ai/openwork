import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxPlatform } from "../src/platform/linux.js";
const api = (await import("../src/platform/types.js").catch(() => ({}))) as any;
test("bridge data directories honor only absolute XDG overrides and stay OS-specific", () => {
  expect(api.platformDirectories).toBeTypeOf("function");
  expect(api.platformDirectories("linux", "/home/test", {})).toEqual({
    state: "/home/test/.local/state/openwork-remote",
    config: "/home/test/.config/openwork-remote",
  });
  expect(
    api.platformDirectories("linux", "/home/test", {
      XDG_STATE_HOME: "relative",
      XDG_CONFIG_HOME: "/data/config",
    }),
  ).toEqual({
    state: "/home/test/.local/state/openwork-remote",
    config: "/data/config/openwork-remote",
  });
  expect(api.platformDirectories("macos", "/Users/test", {})).toEqual({
    state: "/Users/test/Library/Application Support/OpenWorkRemote",
    config: "/Users/test/Library/Application Support/OpenWorkRemote",
  });
});
test("Linux desktop discovery uses inspected Electron config and rejects substituted token files", async () => {
  const home = await mkdtemp(join(tmpdir(), "owr-linux-"));
  const root = join(home, ".config", "com.differentai.openwork");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "openwork-server-state.json"),
    JSON.stringify({ preferredPort: 43210 }),
  );
  await writeFile(
    join(root, "openwork-server-tokens.json"),
    JSON.stringify({ credentials: { clientToken: "synthetic-only" } }),
  );
  try {
    const platform = linuxPlatform({ home, env: {} });
    expect(await platform.discover()).toEqual({
      origin: "http://127.0.0.1:43210",
      token: "synthetic-only",
    });
    await writeFile(
      join(root, "openwork-server-state.json"),
      JSON.stringify({
        preferredPort: null,
        workspacePorts: { ws_test: 43211 },
      }),
    );
    expect((await platform.discover()).origin).toBe("http://127.0.0.1:43211");
    await writeFile(
      join(root, "openwork-server-state.json"),
      JSON.stringify({
        preferredPort: null,
        workspacePorts: { ws_a: 43211, ws_b: 43212 },
      }),
    );
    await expect(platform.discover()).rejects.toThrow("UPSTREAM_UNAVAILABLE");
    await writeFile(
      join(root, "openwork-server-state.json"),
      JSON.stringify({ preferredPort: 43210 }),
    );
    await rm(join(root, "openwork-server-tokens.json"));
    await writeFile(join(home, "substitute.json"), "{}");
    await symlink(
      join(home, "substitute.json"),
      join(root, "openwork-server-tokens.json"),
    );
    await expect(platform.discover()).rejects.toThrow("UNTRUSTED_INSTALLATION");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
