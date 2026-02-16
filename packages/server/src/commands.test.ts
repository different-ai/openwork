import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertCommand } from "./commands.js";
import { parseFrontmatter } from "./frontmatter.js";

describe("upsertCommand", () => {
  test("omits nullable fields when not provided", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openwork-command-test-"));
    try {
      const file = await upsertCommand(workspace, {
        name: "command-proof",
        template: "echo hello",
      });
      const content = await readFile(file, "utf8");
      const parsed = parseFrontmatter(content);
      expect(parsed.data.model).toBeUndefined();
      expect(parsed.data.subtask).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("keeps explicit model and subtask values", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openwork-command-test-"));
    try {
      const file = await upsertCommand(workspace, {
        name: "command-proof-model",
        template: "echo hello",
        model: "openai/gpt-5",
        subtask: true,
      });
      const content = await readFile(file, "utf8");
      const parsed = parseFrontmatter(content);
      expect(parsed.data.model).toBe("openai/gpt-5");
      expect(parsed.data.subtask).toBeTrue();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
