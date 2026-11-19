import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDaytonaHost, type DaytonaExec } from "./daytona.ts";

afterEach(() => vi.useRealTimers());

function hostWithCalls(previewExpirySeconds?: number) {
  const calls: string[][] = [];
  const exec: DaytonaExec = async args => {
    calls.push(args);
    return { code: 0, stdout: `https://signed-${calls.length}.example.test`, stderr: "" };
  };
  return { calls, host: createDaytonaHost({ sandboxId: "owned-vm", repoRoot: "/unused", log: () => {}, exec, previewExpirySeconds }) };
}

test("default previews retain the CLI one-hour default and cached signed origin", async () => {
  const { host, calls } = hostWithCalls();
  expect(await host.previewUrl(6080)).toBe(await host.previewUrl(6080));
  expect(calls).toEqual([["preview-url", "owned-vm", "-p", "6080"]]);
});

test("24-hour preview expiry is explicit, bounded, and cached for less than its validity", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
  const { host, calls } = hostWithCalls(86400);
  const first = await host.previewUrl(6080);
  vi.setSystemTime(new Date("2026-10-20T23:59:00Z"));
  expect(await host.previewUrl(6080)).toBe(first);
  vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
  expect(await host.previewUrl(6080)).not.toBe(first);
  expect(calls).toEqual([
    ["preview-url", "owned-vm", "-p", "6080", "--expires", "86400"],
    ["preview-url", "owned-vm", "-p", "6080", "--expires", "86400"],
  ]);
});

test("refresh is explicit; simultaneous consumers receive one signed origin", async () => {
  const { host, calls } = hostWithCalls(600);
  const first = await host.previewUrl(6080);
  const refreshed = await Promise.all([host.previewUrl(6080, { refresh: true }), host.previewUrl(6080, { refresh: true })]);
  expect(refreshed[0]).not.toBe(first);
  expect(refreshed[0]).toBe(refreshed[1]);
  expect(await host.previewUrl(6080)).toBe(refreshed[0]);
  expect(calls).toHaveLength(2);
});

test("default cached previews also refresh after expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { host, calls } = hostWithCalls();
  const first = await host.previewUrl(9825);
  vi.setSystemTime(3_600_000);
  expect(await host.previewUrl(9825)).not.toBe(first);
  expect(calls).toHaveLength(2);
});

test("invalid preview lifetimes fail before signing", () => {
  for (const expiry of [0, -1, 1.5, 86401, NaN, Infinity]) {
    expect(() => hostWithCalls(expiry)).toThrow(/previewExpirySeconds/);
  }
});

test("failed signing is not cached and does not poison subsequent refresh", async () => {
  let attempts = 0;
  const exec: DaytonaExec = async () => ({ code: 0, stdout: ++attempts === 1 ? "no URL" : "https://retry.example.test", stderr: "" });
  const host = createDaytonaHost({ sandboxId: "owned-vm", repoRoot: "/unused", log: () => {}, exec });
  await expect(host.previewUrl(6080)).rejects.toThrow(/did not print/);
  expect(await host.previewUrl(6080)).toBe("https://retry.example.test");
  expect(attempts).toBe(2);
});

function chromeHostWithCalls() {
  const calls: string[][] = [];
  const exec: DaytonaExec = async args => {
    calls.push(args);
    return { code: 0, stdout: args[0] === "preview-url" ? "https://chrome.example.test" : "", stderr: "" };
  };
  const host = createDaytonaHost({
    sandboxId: "owned-vm", repoRoot: "/unused", log: () => {}, exec,
    waitForCdp: async () => {},
  });
  return { host, calls };
}

/** Ask bash to decode our one shell-quoted remote argument without executing it. */
function chromeLaunchCommand(calls: string[][]): string {
  const launch = calls.find(args => args[0] === "exec" && args[3]?.includes("CHROME_BIN="));
  expect(launch).toBeDefined();
  const decoded = spawnSync("bash", ["-c", `bash() { printf '%s' "$2"; }; ${launch?.[3]}`], { encoding: "utf8" });
  expect(decoded.status, decoded.stderr).toBe(0);
  return decoded.stdout;
}

test("headed Daytona Chrome uses the caller's profile on the VNC display and preserves it on disposal", async () => {
  const { host, calls } = chromeHostWithCalls();
  const profileDir = "/home/daytona/workshop/browser";
  const handle = await host.spawnChrome("workshop", { profileDir, headless: false, startUrl: "https://den.example.test" });
  const launch = chromeLaunchCommand(calls);
  expect(launch).toContain('DISPLAY=:99 nohup "$CHROME_BIN"');
  expect(launch).not.toContain("--headless");
  expect(launch).toContain(`--user-data-dir='${profileDir}'`);
  expect(launch).toContain("--remote-debugging-port=9222");
  expect(launch).toContain("umask 077");
  expect(launch).toContain("root.chmod(0o700)");
  expect(handle.profileDir).toBe(profileDir);
  expect(handle.meta).toMatchObject({ cdpPort: "9222", profileOwner: "caller" });
  await host.disposeSurface(handle);
  expect(calls.some(args => args[0] === "exec" && args.join(" ").includes("pkill -f"))).toBe(true);
  expect(calls.some(args => args.join(" ").includes("rm -rf"))).toBe(false);
});

test("legacy Daytona Chrome remains headless with fresh host-owned profiles and deletes them", async () => {
  const { host, calls } = chromeHostWithCalls();
  const first = await host.spawnChrome("default");
  const second = await host.spawnChrome("default");
  expect(chromeLaunchCommand(calls)).toContain("--headless=new");
  expect(first.profileDir).toMatch(/^\/tmp\/daytona-chrome-default-/);
  expect(second.profileDir).not.toBe(first.profileDir);
  expect(first.meta?.profileOwner).toBe("host");
  await host.disposeSurface(first);
  expect(calls.some(args => args.join(" ").includes("rm -rf") && args.join(" ").includes(first.profileDir ?? "missing"))).toBe(true);
});

test("caller-owned Chrome profile validation rejects unsafe roots before remote operations", async () => {
  const { host, calls } = chromeHostWithCalls();
  for (const profileDir of ["", "relative/path", "/", "///", "/.", "/home/../browser", "/home/./browser", "/home/browser\nnext", "/home/browser\0next"]) {
    await expect(host.spawnChrome("invalid", { profileDir })).rejects.toThrow(/profileDir/);
  }
  expect(calls).toEqual([]);
});

test("a live caller-owned Chrome profile cannot accidentally spawn a duplicate browser", async () => {
  const { host, calls } = chromeHostWithCalls();
  const profileDir = "/home/daytona/workshop/browser";
  await host.spawnChrome("first", { profileDir, headless: false });
  const initialCallCount = calls.length;
  await expect(host.spawnChrome("duplicate", { profileDir, headless: false })).rejects.toThrow(/already owns/);
  expect(calls).toHaveLength(initialCallCount);
});

test("caller profile preparation quotes shell metacharacters, creates a private directory and rejects symlinks", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "daytona-chrome-options-")));
  try {
    const profileDir = join(dir, "browser's $(touch INJECTED)");
    const { host, calls } = chromeHostWithCalls();
    await host.spawnChrome("quoted", { profileDir });
    const preparation = chromeLaunchCommand(calls).split("CHROME_BIN=")[0];
    const prepared = spawnSync("bash", ["-c", preparation], { encoding: "utf8", cwd: dir });
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(statSync(profileDir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, "INJECTED"))).toBe(false);

    mkdirSync(join(dir, "target"));
    symlinkSync(join(dir, "target"), join(dir, "linked-parent"));
    const linked = chromeHostWithCalls();
    await linked.host.spawnChrome("symlink", { profileDir: join(dir, "linked-parent", "browser") });
    const rejected = spawnSync("bash", ["-c", chromeLaunchCommand(linked.calls).split("CHROME_BIN=")[0]], { encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("must not contain symlinks");
    expect(existsSync(join(dir, "target", "browser"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
