import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listTemplateFiles, planTemplateFiles, writeTemplateFiles } from "./template-files.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openwork-template-files-"));
  tempDirs.push(dir);
  await mkdir(join(dir, ".opencode"), { recursive: true });
  return dir;
}

describe("template files", () => {
  test("lists only extra shareable .opencode files", async () => {
    const workspaceRoot = await makeWorkspace();
    await mkdir(join(workspaceRoot, ".opencode", "agents"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "plugins"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "skills", "demo"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "commands"), { recursive: true });

    await writeFile(join(workspaceRoot, ".opencode", "agents", "openwork.md"), "# agent\n", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "plugins", "router.json"), '{"enabled":true}\n', "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "skills", "demo", "SKILL.md"), "# skill\n", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "commands", "demo.md"), "# command\n", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "openwork.json"), '{"version":1}\n', "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "opencode.db"), "sqlite-bytes", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", ".env"), "SECRET=value\n", "utf8");

    const files = await listTemplateFiles(workspaceRoot);

    expect(files).toEqual([
      { path: ".opencode/agents/openwork.md", content: "# agent\n" },
      { path: ".opencode/plugins/router.json", content: '{"enabled":true}\n' },
    ]);
  });

  test("plans and writes validated template files", async () => {
    const workspaceRoot = await makeWorkspace();
    const planned = planTemplateFiles(workspaceRoot, [
      { path: ".opencode/agents/demo.md", content: "hello\n" },
    ]);

    expect(planned[0]?.absolutePath.endsWith("/.opencode/agents/demo.md")).toBe(true);

    await writeTemplateFiles(workspaceRoot, [
      { path: ".opencode/agents/demo.md", content: "hello\n" },
    ]);

    const contents = await readFile(join(workspaceRoot, ".opencode", "agents", "demo.md"), "utf8");
    expect(contents).toBe("hello\n");
  });

  test("rejects env files and path traversal", async () => {
    const workspaceRoot = await makeWorkspace();

    expect(() =>
      planTemplateFiles(workspaceRoot, [{ path: ".opencode/.env", content: "SECRET=value" }]),
    ).toThrow(/not allowed/i);

    expect(() =>
      planTemplateFiles(workspaceRoot, [{ path: "../outside.md", content: "oops" }]),
    ).toThrow(/invalid/i);
  });
});
