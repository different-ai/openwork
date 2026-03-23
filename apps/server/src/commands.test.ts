import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listCommands, upsertCommand } from "./commands.js";

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
});
