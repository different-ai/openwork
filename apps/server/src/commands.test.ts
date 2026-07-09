import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listCommands, repairCommands, upsertCommand } from "./commands.js";

describe("commands", () => {
  test("upsertCommand omits null model from frontmatter", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openwork-commands-"));

    const path = await upsertCommand(workspace, {
      name: "learn-files",
      description: "Learn files",
      template: "Show me the files",
      model: null,
    });

    const content = await readFile(path, "utf8");
    expect(content).not.toContain("model: null");
    expect(content).not.toContain("model:");
  });

  test("listCommands repairs legacy null model frontmatter", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openwork-commands-"));
    const commandsDir = join(workspace, ".opencode", "commands");
    const commandPath = join(commandsDir, "learn-files.md");

    await mkdir(commandsDir, { recursive: true });
    await writeFile(commandPath, "---\nname: learn-files\ndescription: Learn files\nmodel: null\n---\nShow me the files\n", "utf8");

    const commands = await listCommands(workspace, "workspace");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.model).toBeNull();

    const repaired = await readFile(commandPath, "utf8");
    expect(repaired).not.toContain("model: null");
    expect(repaired).not.toContain("model:");
  });

  test("listCommands skips files with malformed frontmatter instead of throwing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openwork-commands-"));
    const commandsDir = join(workspace, ".opencode", "commands");

    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "broken.md"), "---\nname: broken\n  bad: [unclosed\n---\nBody\n", "utf8");
    await writeFile(join(commandsDir, "good.md"), "---\nname: good\ndescription: Good\n---\nDo the thing\n", "utf8");

    const commands = await listCommands(workspace, "workspace");
    expect(commands.map((c) => c.name)).toEqual(["good"]);
  });

  test("repairCommands does not throw on malformed frontmatter", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openwork-commands-"));
    const commandsDir = join(workspace, ".opencode", "commands");

    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "broken.md"), "---\nname: broken\n  bad: [unclosed\n---\nBody\n", "utf8");

    expect(await repairCommands(workspace)).toBe(false);
  });
});
