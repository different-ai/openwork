import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLocalHost } from "./local.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => ({ pid: process.pid, unref: vi.fn(), once: vi.fn() })),
}));
vi.mock("@openwork/cdp", async (importOriginal) => ({
  ...await importOriginal<typeof import("@openwork/cdp")>(),
  allocateFreePort: vi.fn(async () => 0),
  waitForCdp: vi.fn(async () => undefined),
}));

const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENWORK_EVAL_CHROME_HEADLESS", "0");
  vi.stubEnv("OPENWORK_EVAL_SURFACE_LOGS_DIR", "");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openwork-chrome-options-"));
  roots.push(root);
  return { root, host: createLocalHost({ repoRoot: root, rootDir: join(root, "surfaces"), log: () => undefined }) };
}

test("caller-owned Chrome profile is the exact user-data directory and survives disposal", async () => {
  const { root, host } = await workspace();
  const profileDir = join(root, "workshop", "browser");
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "session"), "retained login");

  const handle = await host.spawnChrome("oauth", { profileDir, headless: false, startUrl: "https://example.com" });

  const args = vi.mocked(spawn).mock.calls[0]?.[1];
  expect(args).toContain(`--user-data-dir=${profileDir}`);
  expect(args).toContain("https://example.com");
  expect(args).not.toContain("--headless=new");
  expect(handle.profileDir).toBe(profileDir);
  expect(handle.meta?.profileOwner).toBe("caller");
  // The process is mocked; do not send signals to the test runner.
  await host.disposeSurface({ ...handle, pid: undefined });
  expect(await readFile(join(profileDir, "session"), "utf8")).toBe("retained login");
});

test("caller-owned Chrome can also be headless", async () => {
  const { root, host } = await workspace();
  const profileDir = join(root, "persistent-browser");
  const handle = await host.spawnChrome("headless", { profileDir, headless: true });
  expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain("--headless=new");
  expect(handle.meta?.profileOwner).toBe("caller");
  await host.disposeSurface({ ...handle, pid: undefined });
  await access(profileDir);
});

test("default Chrome keeps its isolated profile layout and ambient headless flag", async () => {
  const { root, host } = await workspace();
  vi.stubEnv("OPENWORK_EVAL_CHROME_HEADLESS", "1");
  const handle = await host.spawnChrome("default");
  expect(handle.profileDir).toMatch(new RegExp(`${root}/surfaces/default-.*?/chrome-profile$`));
  expect(handle.meta?.profileOwner).toBe("host");
  expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain("--headless=new");
  expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain("about:blank");
  await host.disposeSurface({ ...handle, pid: undefined });
});

test.each(["", "   "])("rejects an empty caller profile %j before spawning", async (profileDir) => {
  const { host } = await workspace();
  await expect(host.spawnChrome("invalid", { profileDir })).rejects.toThrow("Chrome profileDir must not be empty.");
  expect(spawn).not.toHaveBeenCalled();
});
