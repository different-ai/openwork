import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { needs, SkipError } from "@openwork/env";

// Exercise the shipped helper's MCP process, without requesting TCC permissions
// or sending input to any app. Packaging is setup, not the assertion boundary.
export function computerUseHelper() {
  needs({ placement: "local" });
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new SkipError("Apple Silicon macOS host with Rosetta for both helper architectures");
  }
  needs({ commands: ["swift"] });
  if (spawnSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], { timeout: 10_000 }).status !== 0) {
    throw new SkipError("Rosetta to execute the Intel helper on Apple Silicon");
  }
  const scratch = mkdtempSync(join(tmpdir(), "computer-use-helper-"));
  const script = resolve(import.meta.dirname, "../../apps/desktop/scripts/prepare-computer-use-helper.mjs");
  const executable = join(scratch, "OpenWork Computer Use.app", "Contents", "MacOS", "ComputerUse");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["TARGET", "TAURI_ENV_TARGET_TRIPLE", "CARGO_CFG_TARGET_TRIPLE", "OPENWORK_COMPUTER_USE_FORCE_BUILD", "OPENWORK_COMPUTER_USE_SIGN_IDENTITY"].includes(key),
  ));
  return {
    stage(target: string) {
      const result = spawnSync(process.execPath, [script, "--outdir", scratch], {
        env: { ...inherited, TARGET: target, OPENWORK_COMPUTER_USE_SIGN_IDENTITY: "-" },
        encoding: "utf8", timeout: 180_000,
      });
      if (result.status !== 0) throw new Error(`Helper staging failed for ${target} (status ${result.status})`);
      const architectures = spawnSync("lipo", ["-archs", executable], { encoding: "utf8", timeout: 10_000 });
      if (architectures.status !== 0) throw new Error("Cannot inspect staged helper architecture");
      return { architectures: architectures.stdout.trim().split(/\s+/), reused: result.stdout.includes('"skipped": true') };
    },
    initialize() {
      const requests = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "packaging-journey", version: "1" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ];
      const result = spawnSync(executable, ["mcp"], { input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n", encoding: "utf8", timeout: 20_000 });
      if (result.status !== 0) throw new Error(`Helper MCP startup failed (status ${result.status})`);
      return result.stdout.trim().split("\n").map((line): unknown => JSON.parse(line));
    },
    close() { rmSync(scratch, { recursive: true, force: true }); },
  };
}
