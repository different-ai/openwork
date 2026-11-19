import { expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSandboxHostConfigOverlay, prepareSandboxHostConfigFolders, resolveSandboxMounts, sandboxMountFingerprint, sandboxMountFingerprintForWrite, sandboxMountGrants } from "../src/sandbox-mounts.js";

test("workspace and runtime Authorized Folders are live mounts at the model's original absolute paths", () => {
  expect(sandboxMountGrants("/work/project", { "*": "ask", "/data/reference/*": "allow", "/private/*": "deny" })).toEqual([
    { hostPath: "/data/reference", guestPath: "/data/reference", access: "rw" },
    { hostPath: "/work/project", guestPath: "/work/project", access: "rw" },
  ]);
});

test("ask and deny do not become mounts, and server read-only applies to every granted bind", () => {
  expect(sandboxMountGrants("/work/project", { "/data/a/*": "ask", "/data/b/*": "deny", "/data/c/*": "allow" }, true)).toEqual([
    { hostPath: "/data/c", guestPath: "/data/c", access: "ro" },
    { hostPath: "/work/project", guestPath: "/work/project", access: "ro" },
  ]);
});

test("a later broad denial removes an earlier grant and restrictive subtrees cannot leak through parent binds", () => {
  expect(sandboxMountGrants("/work/project", { "/data/a/*": "allow", "*": "deny" })).toHaveLength(1);
  expect(() => sandboxMountGrants("/work/project", { "/data/*": "allow", "/data/private/*": "deny" })).toThrow("restricted subtree");
  expect(() => sandboxMountGrants("/work/project", { "/work/project/private/*": "deny" })).toThrow("restricted subtree");
});

test("unrepresentable wildcard policies fail closed rather than become wider binds", () => {
  for (const rules of [{ "*": "allow" }, { "/data/**": "allow" }, { "/data/../private/*": "allow" }, { "relative/*": "allow" }, { "/data/*": { read: "allow" } }]) {
    expect(() => sandboxMountGrants("/work/project", rules)).toThrow();
  }
  expect(() => sandboxMountGrants("/", {})).toThrow("root");
});

test("a denied canonical subtree cannot be reached through a differently spelled allowed bind", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sandbox-alias-"));
  try {
    const actual = join(temp, "actual");
    const alias = join(temp, "alias");
    await mkdir(actual);
    await symlink(actual, alias);
    const rules = { [`${alias}/*`]: "allow", [`${actual}/not-created-yet/*`]: "deny" };
    const plan = sandboxMountGrants(join(temp, "workspace"), rules);
    // The lexical paths differ, but both resolve below the same host directory.
    await expect(resolveSandboxMounts(plan.filter(mount => mount.guestPath === alias), [], rules)).rejects.toThrow("restricted Authorized Folder");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("canonical host paths preserve guest aliases and runtime state cannot be mounted", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sandbox-mounts-"));
  try {
    const host = join(temp, "workspace");
    const runtime = join(temp, "state");
    await mkdir(host);
    await mkdir(runtime);
    const mounts = await resolveSandboxMounts([{ hostPath: host, guestPath: host, access: "rw" }], [runtime]);
    expect(mounts).toEqual([{ hostPath: await realpath(host), guestPath: host, access: "rw" }]);
    await expect(resolveSandboxMounts([{ hostPath: temp, guestPath: temp, access: "rw" }], [runtime])).rejects.toThrow("protected runtime");
    await expect(resolveSandboxMounts([{ hostPath: runtime, guestPath: runtime, access: "ro" }], [runtime])).rejects.toThrow("protected runtime");
    expect(sandboxMountFingerprint(mounts)).not.toEqual(sandboxMountFingerprint(mounts.map(mount => ({ ...mount, access: "ro" }))));
    expect(sandboxMountFingerprint(mounts)).not.toEqual(sandboxMountFingerprint([]));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("git and engine config folders inside a writable mount are mounted again read-only", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "sandbox-config-")));
  try {
    const workspace = join(temp, "workspace");
    const reference = join(temp, "reference");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(reference, ".git"), { recursive: true });
    await writeFile(join(reference, ".opencode"), "a file, not a folder");
    const rules = { [`${reference}/*`]: "allow" };
    await prepareSandboxHostConfigFolders(workspace, false);
    expect((await stat(join(workspace, ".opencode"))).isDirectory()).toBe(true);
    const mounts = await resolveSandboxMounts(sandboxMountGrants(workspace, rules), [], rules);
    expect(mounts).toEqual([
      { hostPath: reference, guestPath: reference, access: "rw" },
      { hostPath: join(reference, ".git"), guestPath: join(reference, ".git"), access: "ro" },
      { hostPath: workspace, guestPath: workspace, access: "rw" },
      { hostPath: join(workspace, ".git"), guestPath: join(workspace, ".git"), access: "ro" },
      { hostPath: join(workspace, ".opencode"), guestPath: join(workspace, ".opencode"), access: "ro" },
    ]);
    expect(mounts.filter(mount => isSandboxHostConfigOverlay(mount, mounts)).map(mount => mount.guestPath)).toEqual([join(reference, ".git"), join(workspace, ".git"), join(workspace, ".opencode")]);
    // A settings write compares the same plan, so it does not restart the sandbox for nothing.
    expect(sandboxMountFingerprintForWrite(workspace, rules, false, [])).toEqual(sandboxMountFingerprint(mounts));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("a read-only workspace gets no extra folders and nothing is created in it", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "sandbox-config-ro-")));
  try {
    await mkdir(join(temp, ".git"));
    await prepareSandboxHostConfigFolders(temp, true);
    await expect(stat(join(temp, ".opencode"))).rejects.toThrow();
    expect(await resolveSandboxMounts(sandboxMountGrants(temp, {}, true), [])).toEqual([{ hostPath: temp, guestPath: temp, access: "ro" }]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
