import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SurfaceHandle } from "@openwork/cdp";
import { createLocalHost, preserveSurfaceLog, pruneStaleSurfaceProfiles } from "./local.ts";

const roots: string[] = [];
const previousLogsDir = process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR;

afterEach(async () => {
  if (previousLogsDir === undefined) delete process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR;
  else process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR = previousLogsDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function hostOwnedProfile(surfacesDir: string, slug: string, log: string) {
  const profileRoot = join(surfacesDir, slug);
  const logPath = join(profileRoot, "electron.log");
  await mkdir(join(profileRoot, "electron-userdata"), { recursive: true });
  await writeFile(logPath, log);
  const handle: SurfaceHandle = {
    name: "packaged-desktop",
    kind: "electron",
    hostKind: "local",
    // Port 0 names no port, so disposal frees nothing on this machine.
    cdpUrl: "http://127.0.0.1:0",
    profileDir: profileRoot,
    meta: { log: logPath, profileRoot, profileOwner: "host" },
  };
  return { handle, profileRoot };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openwork-surface-log-"));
  roots.push(root);
  return {
    root,
    surfacesDir: join(root, "profiles", "desktop-updater-gate-enterprise"),
    logsDir: join(root, "logs", "desktop-updater-gate-enterprise"),
  };
}

test("disposal keeps a host-owned desktop's log outside the profile it removes", async () => {
  const { root, surfacesDir, logsDir } = await workspace();
  const { handle, profileRoot } = await hostOwnedProfile(surfacesDir, "packaged-preactivation-updater-1-4242", "APPIMAGE env is not defined\n");
  process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR = logsDir;
  const messages: string[] = [];
  const host = createLocalHost({ repoRoot: root, rootDir: surfacesDir, log: (message) => messages.push(message) });

  await host.disposeSurface(handle);

  await expect(access(profileRoot)).rejects.toThrow();
  const kept = join(logsDir, "packaged-preactivation-updater-1-4242-electron.log");
  expect(await readFile(kept, "utf8")).toBe("APPIMAGE env is not defined\n");
  expect(messages).toContain(`Kept packaged-desktop log at ${kept}`);

  // The next launch prunes every entry of the surfaces root that is not live; the copy is outside it.
  await mkdir(join(surfacesDir, "stale-profile"), { recursive: true });
  const pruned = await pruneStaleSurfaceProfiles(surfacesDir, { live: new Set(), kill: async () => undefined });
  expect(pruned.removed).toEqual([join(surfacesDir, "stale-profile")]);
  await access(kept);
});

test("without the setting disposal copies nothing and still removes the profile", async () => {
  const { root, surfacesDir, logsDir } = await workspace();
  const { handle, profileRoot } = await hostOwnedProfile(surfacesDir, "app-smoke-1-4243", "boot\n");
  delete process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR;
  const host = createLocalHost({ repoRoot: root, rootDir: surfacesDir, log: () => undefined });

  await host.disposeSurface(handle);

  await expect(access(profileRoot)).rejects.toThrow();
  await expect(access(logsDir)).rejects.toThrow();
});

test("a surface without a log on disk is not an error", async () => {
  const { surfacesDir, logsDir } = await workspace();
  const { handle } = await hostOwnedProfile(surfacesDir, "never-started-1-4244", "");
  await rm(join(surfacesDir, "never-started-1-4244"), { recursive: true });

  expect(await preserveSurfaceLog(handle, logsDir)).toBeNull();
  expect(await preserveSurfaceLog({ ...handle, meta: {} }, logsDir)).toBeNull();
});
