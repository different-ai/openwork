import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { daytonaSandboxLimitArgs, type DaytonaExec } from "./daytona.ts";
import { denProvisionScriptArgs, parseDenUrlsFile, provisionDenSandbox, provisionDesktopSandbox } from "./provision.ts";

const quiet = () => {};
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

test("provider resource units and wall-clock TTL are explicit and opt-in", () => {
  expect(daytonaSandboxLimitArgs({})).toEqual([]);
  expect(daytonaSandboxLimitArgs({ cpu: 2, memoryGiB: 4, ttlMinutes: 1440 })).toEqual([
    "--cpu", "2", "--memory", "4", "--ttl", "1440",
  ]);
  // API units, not the incorrect CLI 0.200.1 help: 1 GiB must stay 1.
  expect(daytonaSandboxLimitArgs({ memoryGiB: 1 })).toEqual(["--memory", "1"]);
});

test("provider limits reject invalid or unbounded values", () => {
  for (const value of [0, -1, 1.5, 1441, NaN, Infinity]) {
    expect(() => daytonaSandboxLimitArgs({ ttlMinutes: value })).toThrow(/ttlMinutes/);
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    expect(() => daytonaSandboxLimitArgs({ cpu: value })).toThrow(/cpu/);
  }
  for (const value of [0, -1, 0.5, 0.0001, NaN, Infinity, 2_147_483_648]) {
    expect(() => daytonaSandboxLimitArgs({ memoryGiB: value })).toThrow(/memoryGiB/);
  }
});

test("Den script arguments preserve old defaults and add scoped private limits", () => {
  expect(denProvisionScriptArgs("dev", "test-box")).toEqual([
    ".devcontainer/test-server-on-daytona.sh", "dev", "--seed", "--name", "test-box", "--auto-stop", "60",
  ]);
  expect(denProvisionScriptArgs("dev", "test-box", 0, {
    private: true, cpu: 4, memoryGiB: 8, ttlMinutes: 1440, previewExpirySeconds: 86400,
  })).toEqual([
    ".devcontainer/test-server-on-daytona.sh", "dev", "--seed", "--name", "test-box", "--auto-stop", "0",
    "--private", "--cpu", "4", "--memory-gib", "8", "--ttl", "1440", "--preview-expiry-seconds", "86400",
  ]);
  expect(denProvisionScriptArgs("dev", "private-workshop", 0, { private: true, seedDemo: false })).not.toContain("--seed");
  expect(() => denProvisionScriptArgs("dev", "test-box", 0, { previewExpirySeconds: 86401 })).toThrow(/previewExpirySeconds/);
});

function creationExec(publicState: unknown = false) {
  const calls: string[][] = [];
  const exec: DaytonaExec = async args => {
    calls.push(args);
    if (args[0] === "snapshot") return { code: 0, stdout: JSON.stringify([{ id: "snapshot-id", name: "openwork-eval-vnc" }]), stderr: "" };
    if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ public: publicState }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("private desktop verifies actual provider state before initialization, with no shared secrets", async () => {
  const { exec, calls } = creationExec();
  await expect(provisionDesktopSandbox({
    ref: "dev", name: "attendee", private: true, secrets: false, ttlMinutes: 1440,
    exec, log: quiet, onCreated: async () => { throw new Error("stop after verified create"); },
  })).rejects.toThrow("stop after verified create");
  const create = calls.find(args => args[0] === "create");
  expect(create).toEqual(expect.arrayContaining(["--snapshot", "snapshot-id", "--ttl", "1440"]));
  expect(create).not.toContain("--cpu");
  expect(create).not.toContain("--memory");
  expect(create).not.toContain("--public");
  expect(create).not.toContain("--volume");
  expect(calls.map(args => args[0])).toEqual(["snapshot", "create", "info", "delete"]);
});

test("desktop public default is unchanged and does not add resources or TTL", async () => {
  const { exec, calls } = creationExec();
  await expect(provisionDesktopSandbox({
    ref: "dev", name: "old-preview", exec, log: quiet,
    onCreated: async () => { throw new Error("stop after create"); },
  })).rejects.toThrow("stop after create");
  const create = calls.find(args => args[0] === "create");
  expect(create).toContain("--public");
  for (const flag of ["--cpu", "--memory", "--ttl", "--volume"]) expect(create).not.toContain(flag);
  expect(calls.some(args => args[0] === "info")).toBe(false);
});

test("private desktop fails closed and deletes a public or unverifiable VM", async () => {
  for (const state of [true, undefined, "false"]) {
    const { exec, calls } = creationExec(state);
    // undefined uses the helper default, so explicitly return an absent field.
    const wrapped: DaytonaExec = args => args[0] === "info" && state === undefined
      ? Promise.resolve({ code: 0, stdout: "{}", stderr: "" }) : exec(args);
    await expect(provisionDesktopSandbox({ ref: "dev", name: "attendee", private: true, exec: wrapped, log: quiet })).rejects.toThrow(/public:false/);
    expect(calls.some(args => args[0] === "delete")).toBe(true);
    expect(calls.some(args => args[0] === "exec")).toBe(false);
  }
});

test("private provisioning cannot reuse an unverified VM; invalid TTL has no provider calls", async () => {
  const { exec, calls } = creationExec();
  await expect(provisionDesktopSandbox({ ref: "dev", name: "x", private: true, reuse: "existing", exec, log: quiet })).rejects.toThrow(/cannot reuse/);
  await expect(provisionDenSandbox({ ref: "dev", private: true, reuse: "existing", exec, log: quiet })).rejects.toThrow(/cannot reuse/);
  await expect(provisionDesktopSandbox({ ref: "dev", name: "x", ttlMinutes: 1441, exec, log: quiet })).rejects.toThrow(/ttlMinutes/);
  await expect(provisionDenSandbox({ ref: "dev", ttlMinutes: 0, exec, log: quiet })).rejects.toThrow(/ttlMinutes/);
  await expect(provisionDesktopSandbox({ ref: "dev", name: "x", reuse: "existing", ttlMinutes: 1440, exec, log: quiet })).rejects.toThrow(/creation/);
  await expect(provisionDenSandbox({ ref: "dev", reuse: "existing", cpu: 4, exec, log: quiet })).rejects.toThrow(/creation/);
  expect(calls).toEqual([]);
});

function runServerScript(args: string[], publicState = "false", snapshot = true) {
  const dir = mkdtempSync(join(tmpdir(), "daytona-options-test-"));
  try {
    const callsFile = join(dir, "calls.jsonl");
    const urlsFile = join(dir, "urls.env");
    writeFileSync(join(dir, "daytona"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "snapshot") console.log(JSON.stringify(${snapshot ? '[{ id: "server-snapshot", name: "openwork-server" }]' : '[]'}));
if (args[0] === "info") console.log(${JSON.stringify(publicState === "missing" ? "{}" : `{"public":${publicState}}`)});
if (args[0] === "preview-url") console.log("https://signed-port-" + args[args.indexOf("-p") + 1] + ".example.test");
`, { mode: 0o755 });
    writeFileSync(join(dir, "curl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const result = spawnSync("bash", [".devcontainer/test-server-on-daytona.sh", "dev", ...args], {
      cwd: repoRoot, encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_CALLS: callsFile,
        DAYTONA_API_KEY: "controller-only-test-key", DAYTONA_API_URL: "https://app.daytona.io/api",
        OPENWORK_DEN_URLS_FILE: urlsFile,
        OPENWORK_DEN_EXTRA_ENV_B64: Buffer.from("GATEWAY_ENABLED=true\nGATEWAY_PORT=8791").toString("base64"),
        DEN_API_PORT: "8788", DEN_WEB_PORT: "3005", DAYTONA_SERVER_SNAPSHOT: "openwork-server",
      },
    });
    const calls: string[][] = readFileSync(callsFile, { encoding: "utf8", flag: "a+" }).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const urls = result.status === 0 ? parseDenUrlsFile(readFileSync(urlsFile, "utf8")) : null;
    return { result, calls, urls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("private server verifies actual privacy and bakes the exact 24-hour signed backend identities", () => {
  const { result, calls, urls } = runServerScript(["--private", "--ttl", "1440", "--preview-expiry-seconds", "86400"]);
  expect(result.status, result.stderr).toBe(0);
  const create = calls.find(args => args[0] === "create");
  expect(create).not.toContain("--public");
  expect(create).not.toContain("--volume");
  expect(JSON.stringify(calls)).not.toContain("controller-only-test-key");
  expect(JSON.stringify(calls)).not.toContain("DAYTONA_API_KEY");
  expect(create).toEqual(expect.arrayContaining(["--snapshot", "server-snapshot", "--ttl", "1440"]));
  expect(create).not.toContain("--cpu");
  expect(create).not.toContain("--memory");
  expect(calls.map(args => args[0]).slice(0, 4)).toEqual(["snapshot", "create", "info", "exec"]);
  expect(calls.filter(args => args[0] === "preview-url").map(args => args.slice(2))).toEqual([
    ["-p", "3005", "--expires", "86400"], ["-p", "8788", "--expires", "86400"], ["-p", "8791", "--expires", "86400"],
  ]);
  expect(urls).toEqual({ webUrl: "https://signed-port-3005.example.test", apiUrl: "https://signed-port-8788.example.test", gatewayUrl: "https://signed-port-8791.example.test" });
  const launch = calls.find(args => args[0] === "exec" && args.join(" ").includes("RUN_SEED="));
  expect(launch?.join(" ")).toContain('DEN_WEB_PUBLIC_URL="https://signed-port-3005.example.test"');
  expect(launch?.join(" ")).toContain('DEN_API_PUBLIC_URL="https://signed-port-8788.example.test"');
  expect(launch?.join(" ")).toContain('GATEWAY_PUBLIC_URL="https://signed-port-8791.example.test"');
});

test("server default remains public, supports short preview expiry, and preserves its 8 GiB fallback", () => {
  const { result, calls } = runServerScript(["--preview-expiry-seconds", "600"], "false", false);
  expect(result.status, result.stderr).toBe(0);
  const create = calls.find(args => args[0] === "create");
  expect(create).toContain("--public");
  expect(create).toEqual(expect.arrayContaining(["--cpu", "4", "--memory", "8"]));
  expect(create).not.toContain("--ttl");
  expect(calls.some(args => args[0] === "info")).toBe(false);
  expect(calls.filter(args => args[0] === "preview-url").every(args => args.at(-1) === "600")).toBe(true);
});

test("server fails closed on provider privacy mismatch and cleans up without starting services", () => {
  for (const state of ["true", "missing", '"false"']) {
    const { result, calls } = runServerScript(["--private"], state);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("public:false");
    expect(calls.some(args => args[0] === "delete")).toBe(true);
    expect(calls.some(args => args[0] === "exec" || args[0] === "preview-url")).toBe(false);
  }
});

test("snapshot CPU/memory overrides fail before creating any infrastructure", async () => {
  const { exec, calls } = creationExec();
  for (const resources of [{ cpu: 4 }, { memoryGiB: 8 }]) {
    await expect(provisionDesktopSandbox({ ref: "dev", name: "fixed", ...resources, exec, log: quiet })).rejects.toThrow(/snapshot resources are fixed/);
  }
  expect(calls).toEqual([]);
  for (const args of [["--cpu", "4"], ["--memory-gib", "8"]]) {
    const result = runServerScript(args);
    expect(result.result.status).not.toBe(0);
    expect(result.result.stderr).toContain("snapshot resources are fixed");
    expect(result.calls.map(call => call[0])).toEqual(["snapshot"]);
  }
});

test("Dockerfile fallback forwards explicit CPU and memory in GiB", () => {
  const { result, calls } = runServerScript(["--cpu", "2", "--memory-gib", "4"], "false", false);
  expect(result.status, result.stderr).toBe(0);
  expect(calls.find(args => args[0] === "create")).toEqual(expect.arrayContaining(["--cpu", "2", "--memory", "4"]));
});

test("server rejects unbounded TTL and preview expiry before infrastructure calls", () => {
  for (const args of [["--ttl", "1441"], ["--ttl", "0"], ["--preview-expiry-seconds", "86401"], ["--memory-gib", "0"], ["--cpu", "1.5"]]) {
    const { result, calls } = runServerScript(args);
    expect(result.status).not.toBe(0);
    expect(calls).toEqual([]);
  }
});
