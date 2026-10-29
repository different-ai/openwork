import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspaceFiles } from "../src/workspace-init";

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
