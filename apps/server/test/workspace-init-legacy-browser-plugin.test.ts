import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalWorkspaceFiles, ensureWorkspaceFiles } from "../src/workspace-init";

const roots: string[] = [];
async function workspaceWith(content: string) {
  const root = await mkdtemp(join(tmpdir(), "openwork-legacy-browser-"));
  roots.push(root);
  await writeFile(join(root, "opencode.jsonc"), content);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy browser plugin cleanup", () => {
  test("removes the entry older OpenWork versions added and keeps the rest of the file", async () => {
    const root = await workspaceWith(`{
  // my settings
  "default_agent": "openwork",
  "plugin": ["opencode-chrome-devtools", "user-plugin"]
}
`);
    expect(await ensureWorkspaceFiles(root, "starter")).toEqual({ changed: true, reloadReasons: ["config"] });
    const content = await readFile(join(root, "opencode.jsonc"), "utf8");
    expect(content).toContain("// my settings");
    expect(content).toContain('"user-plugin"');
    expect(content).not.toContain("opencode-chrome-devtools");
    expect(await ensureWorkspaceFiles(root, "starter")).toEqual({ changed: false, reloadReasons: [] });
  });

  test("drops the plugin key when the legacy entry was the only plugin", async () => {
    const root = await workspaceWith(`{ "default_agent": "openwork", "plugin": ["opencode-chrome-devtools"] }\n`);
    await ensureWorkspaceFiles(root, "starter");
    expect(JSON.parse(await readFile(join(root, "opencode.jsonc"), "utf8"))).toEqual({ default_agent: "openwork" });
  });

  test("leaves a version-pinned entry someone added on purpose", async () => {
    const content = `{ "plugin": ["opencode-chrome-devtools@1.0.4"] }\n`;
    const root = await workspaceWith(content);
    expect(await ensureWorkspaceFiles(root, "starter")).toEqual({ changed: false, reloadReasons: [] });
    expect(await readFile(join(root, "opencode.jsonc"), "utf8")).toBe(content);
  });
});

describe("unreadable workspace config", () => {
  test("skips the cleanup when the config path cannot be read as a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-legacy-browser-"));
    roots.push(root);
    await mkdir(join(root, "opencode.jsonc"));
    expect(await ensureWorkspaceFiles(root, "starter")).toEqual({ changed: false, reloadReasons: [] });
  });

  const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;
  test.skipIf(!canDenyAccess)("skips the cleanup when the OS denies access to the config", async () => {
    const root = await workspaceWith(`{ "plugin": ["opencode-chrome-devtools"] }\n`);
    const path = join(root, "opencode.jsonc");
    await chmod(path, 0o000);
    try {
      expect(await ensureWorkspaceFiles(root, "starter")).toEqual({ changed: false, reloadReasons: [] });
    } finally {
      await chmod(path, 0o644);
    }
  });

  // A named pipe with no writer blocks a read forever, the same way a
  // cloud-offloaded file does when it cannot be downloaded.
  test.skipIf(process.platform === "win32")("gives up on a config read that never returns and fails later calls at once", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-legacy-browser-"));
    roots.push(root);
    const path = join(root, "opencode.jsonc");
    execFileSync("mkfifo", [path]);
    const healthy = await workspaceWith(`{ "plugin": ["opencode-chrome-devtools"] }\n`);

    const startedAt = Date.now();
    await expect(ensureWorkspaceFiles(root, "starter")).rejects.toMatchObject({ status: 409, code: "workspace_inaccessible" });
    expect(Date.now() - startedAt).toBeLessThan(8_000);

    const againAt = Date.now();
    await expect(ensureWorkspaceFiles(root, "starter")).rejects.toMatchObject({ code: "workspace_inaccessible" });
    expect(Date.now() - againAt).toBeLessThan(500);

    // Startup provisions every workspace in turn: the blocked one is skipped
    // and the next one is still set up.
    await ensureLocalWorkspaceFiles([{ path: root, preset: "starter" }, { path: healthy, preset: "starter" }]);
    expect(await readFile(join(healthy, "opencode.jsonc"), "utf8")).not.toContain("opencode-chrome-devtools");

    // A writer lets the blocked read finish; the workspace is readable again.
    await writeFile(path, "{}\n");
    await rm(path);
    await writeFile(path, "{}\n");
    let recovered: unknown;
    for (let attempt = 0; attempt < 40 && recovered === undefined; attempt += 1) {
      recovered = await ensureWorkspaceFiles(root, "starter").catch(() => undefined);
      if (recovered === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(recovered).toEqual({ changed: false, reloadReasons: [] });
  }, 20_000);
});
