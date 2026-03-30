import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPortableFiles, planPortableFiles, writePortableFiles } from "./portable-files.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openwork-portable-files-"));
  tempDirs.push(dir);
  await mkdir(join(dir, ".opencode"), { recursive: true });
  return dir;
}

describe("portable files", () => {
  test("lists only extra shareable .opencode files", async () => {
    const workspaceRoot = await makeWorkspace();
    await mkdir(join(workspaceRoot, ".opencode", "agents"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "plugins"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "tools"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "node_modules", "demo"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "skills", "demo"), { recursive: true });
    await mkdir(join(workspaceRoot, ".opencode", "commands"), { recursive: true });

    await writeFile(join(workspaceRoot, ".opencode", "agents", "openwork.md"), "# agent\n", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "plugins", "router.json"), '{"enabled":true}\n', "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "tools", "database.ts"), "export default {};\n", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "node_modules", "demo", "index.js"), "export default 1;\n", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "skills", "demo", "SKILL.md"), "# skill\n", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "commands", "demo.md"), "# command\n", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "openwork.json"), '{"version":1}\n', "utf8");
    await writeFile(join(workspaceRoot, ".opencode", "opencode.db"), "sqlite-bytes", "utf8");
    await writeFile(join(workspaceRoot, ".opencode", ".env"), "SECRET=value\n", "utf8");

    const files = await listPortableFiles(workspaceRoot);

    expect(files).toEqual([
      { path: ".opencode/agents/openwork.md", content: "# agent\n" },
      { path: ".opencode/plugins/router.json", content: '{"enabled":true}\n' },
      { path: ".opencode/tools/database.ts", content: "export default {};\n" },
    ]);
  });

  test("plans and writes validated portable files", async () => {
    const workspaceRoot = await makeWorkspace();
    const planned = planPortableFiles(workspaceRoot, [
      { path: ".opencode/agents/demo.md", content: "hello\n" },
      { path: ".opencode/tools/demo.ts", content: "export default {};\n" },
    ]);

    expect(planned[0]?.absolutePath.endsWith("/.opencode/agents/demo.md")).toBe(true);
    expect(planned[1]?.absolutePath.endsWith("/.opencode/tools/demo.ts")).toBe(true);

    await writePortableFiles(workspaceRoot, [
      { path: ".opencode/agents/demo.md", content: "hello\n" },
      { path: ".opencode/tools/demo.ts", content: "export default {};\n" },
    ]);

    const contents = await readFile(join(workspaceRoot, ".opencode", "agents", "demo.md"), "utf8");
    const toolContents = await readFile(join(workspaceRoot, ".opencode", "tools", "demo.ts"), "utf8");
    expect(contents).toBe("hello\n");
    expect(toolContents).toBe("export default {};\n");
  });

  test("rejects non-allowlisted portable files and path traversal", async () => {
    const workspaceRoot = await makeWorkspace();

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: ".opencode/.env", content: "SECRET=value" }]),
    ).toThrow(/not allowed/i);

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: ".opencode/package.json", content: "{}" }]),
    ).toThrow(/not allowed/i);

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: ".opencode/openwork.json", content: "{}" }]),
    ).toThrow(/not allowed/i);

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: "../outside.md", content: "oops" }]),
    ).toThrow(/invalid/i);

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: ".opencode/node_modules/demo/index.js", content: "oops" }]),
    ).toThrow(/not allowed/i);
  });
});
