import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveGlobalOpenCodeConfigPath } from "./mcp.js";
import { resolveOpencodeConfigFilePath } from "./server.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("OpenCode config path resolution", () => {
  test("server global config path follows MCP when OPENCODE_CONFIG_DIR is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-opencode-config-path-"));
    const previousOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      const opencodeConfigDir = join(root, "dev-opencode-config");
      await mkdir(opencodeConfigDir, { recursive: true });
      const expected = join(opencodeConfigDir, "opencode.json");
      await writeFile(expected, "{}", "utf8");
      process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir;
      process.env.XDG_CONFIG_HOME = join(root, "xdg");

      expect(resolveOpencodeConfigFilePath("global", join(root, "workspace"))).toBe(resolveGlobalOpenCodeConfigPath());
      expect(resolveOpencodeConfigFilePath("global", join(root, "workspace"))).toBe(expected);
    } finally {
      restoreEnv("OPENCODE_CONFIG_DIR", previousOpencodeConfigDir);
      restoreEnv("XDG_CONFIG_HOME", previousXdgConfigHome);
      await rm(root, { recursive: true, force: true });
    }
  });
});
