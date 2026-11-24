import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPENWORK_BENCH_REVISION } from "../../evals/worlds/openwork-bench-source.ts";
import { benchInstallScript, parseBenchGuestReport, parseBenchWorldOptions } from "./openwork-bench.ts";
import { ENV_NAMES, envFileText } from "./openwork-bench-guest.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("the world installs the pinned benchmark revision and needs a finite lifetime", () => {
  assert.deepEqual(parseBenchWorldOptions([]), { benchRef: OPENWORK_BENCH_REVISION, lifetimeMinutes: 240 });
  assert.deepEqual(parseBenchWorldOptions(["--bench-ref", SHA, "--lifetime", "60"]), { benchRef: SHA, lifetimeMinutes: 60 });
  assert.throws(() => parseBenchWorldOptions(["--bench-ref", "main"]));
  assert.throws(() => parseBenchWorldOptions(["--lifetime", "0"]));
  assert.throws(() => parseBenchWorldOptions(["--lifetime", "1431"]));
  assert.throws(() => parseBenchWorldOptions(["--ref", SHA]));
});

test("the install script is valid bash, pins one revision for the CLI and the tasks, and prints only the guest report", () => {
  const script = benchInstallScript({ benchRef: SHA, cdpPort: 9825, guestScript: "console.log('guest')\n" });
  execFileSync("bash", ["-n"], { input: script });
  assert.match(script, new RegExp(`uv tool install --force --python 3\\.13 'openwork-bench\\[all\\] @ git\\+https://github\\.com/different-ai/openwork-bench@${SHA}'`));
  assert.match(script, new RegExp(`fetch -q --depth 1 https://github\\.com/different-ai/openwork-bench ${SHA}`));
  assert.match(script, /node "\$dir\/openwork-bench-guest\.mjs" 9825 "\$dir\/openwork\.env" "\$dir\/repo\/tasks"$/);
  for (const line of script.split("\n").filter((entry) => /^(uv|curl|command -v uv)/.test(entry))) assert.match(line, />&2$/);
  assert.throws(() => benchInstallScript({ benchRef: "main", cdpPort: 9825, guestScript: "" }));
  assert.throws(() => benchInstallScript({ benchRef: SHA, cdpPort: 0, guestScript: "" }));
});

test("the env file sources back to the exact values, including quotes", () => {
  const values: Record<string, string> = { OPENWORK_URL: "http://127.0.0.1:8787", OPENWORK_TOKEN: "it's $HOME `x`", OPENWORK_HOST_TOKEN: "host-token", OWB_TASKS_DIR: "/home/daytona/openwork-bench/repo/tasks" };
  const file = join(mkdtempSync(join(tmpdir(), "openwork-bench-env-")), "openwork.env");
  writeFileSync(file, envFileText(values));
  const printed = execFileSync("bash", ["-c", `source "$1" && printf '%s\\n' "$OPENWORK_URL" "$OPENWORK_TOKEN" "$OPENWORK_HOST_TOKEN" "$OWB_TASKS_DIR"`, "bash", file], { encoding: "utf8" });
  assert.deepEqual(printed.trimEnd().split("\n"), ENV_NAMES.map((name) => values[name]));
  assert.throws(() => envFileText({ ...values, OPENWORK_HOST_TOKEN: "" }));
});

test("the guest report must name a loopback server and the env file, and carries no token", () => {
  const report = { openworkUrl: "http://127.0.0.1:8787", envFile: "/home/daytona/openwork-bench/openwork.env", names: ENV_NAMES };
  assert.deepEqual(parseBenchGuestReport(`installing\n${JSON.stringify(report)}\n`), { openworkUrl: report.openworkUrl, envFile: report.envFile });
  assert.throws(() => parseBenchGuestReport(JSON.stringify({ ...report, openworkUrl: "https://public.example" })));
  assert.throws(() => parseBenchGuestReport(JSON.stringify({ ...report, names: ["OPENWORK_URL"] })));
  assert.throws(() => parseBenchGuestReport("uv: command not found"));
});
