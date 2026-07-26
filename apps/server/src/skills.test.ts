import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteSkill, listSkills } from "./skills.js";
import { exists } from "./utils.js";

let workspace: string;

async function writeSkill(dir: string, name: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\nBody\n`, "utf8");
}

async function writeSkillContent(name: string, content: string) {
  const dir = join(workspace, ".opencode", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
}

async function collectServerSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "opencode-plugins") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectServerSourceFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === ".ts" && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }

  return files;
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "openwork-skills-"));
  await mkdir(join(workspace, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("deleteSkill", () => {
  test("deletes a flat skill", async () => {
    const dir = join(workspace, ".opencode", "skills", "flat-skill");
    await writeSkill(dir, "flat-skill");
    await deleteSkill(workspace, "flat-skill");
    expect(await exists(dir)).toBe(false);
  });

  test("deletes a plugin-namespaced (nested) skill", async () => {
    // Marketplace plugin bundles install skills under skills/<plugin>/<name>/
    const dir = join(workspace, ".opencode", "skills", "bio-research-plugin", "instrument-data-to-allotrope");
    await writeSkill(dir, "instrument-data-to-allotrope");

    const listed = await listSkills(workspace, false);
    expect(listed.map((s) => s.name)).toContain("instrument-data-to-allotrope");

    await deleteSkill(workspace, "instrument-data-to-allotrope");
    expect(await exists(dir)).toBe(false);
  });

  test("404s for unknown skills", async () => {
    await expect(deleteSkill(workspace, "does-not-exist")).rejects.toThrow("Skill not found");
  });
});

describe("listSkills trigger extraction", () => {
  test("matches org skill markdown trigger cases", async () => {
    const cases: Array<{ name: string; content: string; expected: string | undefined }> = [
      {
        name: "frontmatter-trigger",
        content: "---\ndescription: Test skill\ntrigger: Review high-priority requests\n---\n# Review",
        expected: "Review high-priority requests",
      },
      {
        name: "frontmatter-trigger-single-quoted",
        content: "---\ndescription: Test skill\ntrigger: 'Review high-priority requests'\n---\n# Review",
        expected: "Review high-priority requests",
      },
      {
        name: "frontmatter-trigger-double-quoted",
        content: "---\ndescription: Test skill\ntrigger: \"Review high-priority requests\"\n---\n# Review",
        expected: "Review high-priority requests",
      },
      {
        name: "frontmatter-when",
        content: "---\ndescription: Test skill\nwhen: Prepare release notes\n---\n# Release",
        expected: "Prepare release notes",
      },
      {
        name: "nested-trigger",
        content: "---\ndescription: Test skill\nmetadata:\n  trigger: Nested value\n---\n# Review",
        expected: undefined,
      },
      {
        name: "block-trigger",
        content: "---\ndescription: Test skill\ntrigger: |\n  Multi-line trigger\n---\n# Review",
        expected: undefined,
      },
      {
        name: "body-trigger",
        content: "---\ndescription: Test skill\n---\n# Review\n\n## When to use\n- Triage incoming requests\n- Draft replies",
        expected: "Triage incoming requests",
      },
      {
        name: "no-trigger",
        content: "---\ndescription: Test skill\n---\n# Review\n\nUse this skill carefully.",
        expected: undefined,
      },
    ];

    for (const item of cases) {
      await writeSkillContent(item.name, item.content);
    }

    const byName = new Map((await listSkills(workspace, false)).map((skill) => [skill.name, skill.trigger]));
    for (const item of cases) {
      expect(byName.has(item.name)).toBe(true);
      expect(byName.get(item.name)).toBe(item.expected);
    }
  });
});

describe("server source imports", () => {
  test("keeps source-only shared packages out of unbundled runtime imports", async () => {
    const sourceDir = fileURLToPath(new URL(".", import.meta.url));
    const forbidden = "@openwork/" + "types";
    const escapedForbidden = forbidden.replace("/", "\\/");
    const importPattern = new RegExp(`\\bimport\\s+(?:type\\s+)?[^;]*?\\s+from\\s+["']${escapedForbidden}(?:\\/[^"']*)?["']`, "g");
    const offenders: string[] = [];

    for (const file of await collectServerSourceFiles(sourceDir)) {
      const content = await readFile(file, "utf8");
      for (const match of content.matchAll(importPattern)) {
        const declaration = match[0].trimStart();
        if (declaration.startsWith("import type ")) continue;

        const line = typeof match.index === "number"
          ? content.slice(0, match.index).split(/\r?\n/).length
          : 1;
        offenders.push(`${file}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
