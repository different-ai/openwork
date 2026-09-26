import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitForEngineSkillChanges } from "./opencode-v2-skill-settle.js";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openwork-v2-skill-settle-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function writeSkill(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

test("an install or edit OpenWork just wrote is awaited until the engine serves its current body", async () => {
  await withWorkspace(async (root) => {
    const skill = join(root, ".opencode", "skills", "notes", "SKILL.md");
    await writeSkill(skill, "---\nname: notes\ndescription: Notes\n---\nCurrent body\n");
    let reads = 0;
    const reflected = await waitForEngineSkillChanges(root, async () => {
      reads++;
      return reads === 1
        ? { data: [{ name: "notes", location: skill, content: "Old body" }] }
        : { data: [{ name: "notes", location: skill, content: "Current body\n" }] };
    });
    expect(reflected).toBe(true);
    expect(reads).toBe(2);
  });
});

test("a removal OpenWork just made is awaited until the engine stops serving it", async () => {
  await withWorkspace(async (root) => {
    const removed = join(root, ".opencode", "skills", "gone", "SKILL.md");
    let reads = 0;
    const reflected = await waitForEngineSkillChanges(root, async () => {
      reads++;
      return { data: reads === 1 ? [{ name: "gone", location: removed, content: "x" }] : [] };
    });
    expect(reflected).toBe(true);
    expect(reads).toBe(2);
  });
});

test("skills outside .opencode/skills, including duplicates in agent folders, never cause a wait", async () => {
  await withWorkspace(async (root) => {
    // The same skill installed in .agents/skills and .claude/skills: the engine
    // serves one of them, and neither is OpenWork's to reconcile.
    for (const dir of [".agents", ".claude"]) {
      await writeSkill(join(root, dir, "skills", "mix-tape", "SKILL.md"), "---\nname: mix-tape\ndescription: Playground\n---\nBody\n");
    }
    let reads = 0;
    const reflected = await waitForEngineSkillChanges(root, async () => {
      reads++;
      return { data: [
        { name: "mix-tape", location: join(root, ".agents", "skills", "mix-tape", "SKILL.md"), content: "Body" },
        { name: "plugin-skill", location: join(root, ".opencode", "plugins", "x", "SKILL.md"), content: "unrelated" },
      ] };
    });
    expect(reflected).toBe(true);
    expect(reads).toBe(1);
  });
});

test("a skill the engine serves under the same name from another file counts as reflected", async () => {
  await withWorkspace(async (root) => {
    const shadowed = join(root, ".opencode", "skills", "plugin-a", "release", "SKILL.md");
    await writeSkill(shadowed, "---\nname: release\n---\nNested copy\n");
    await writeSkill(join(root, ".opencode", "skills", "release", "SKILL.md"), "---\nname: release\n---\nFlat copy\n");
    let reads = 0;
    const reflected = await waitForEngineSkillChanges(root, async () => {
      reads++;
      return { data: [{ name: "release", location: join(root, ".opencode", "skills", "release", "SKILL.md"), content: "Flat copy" }] };
    });
    expect(reflected).toBe(true);
    expect(reads).toBe(1);
  });
});

test("files the engine would skip (malformed frontmatter) are not awaited", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(join(root, ".opencode", "skills", "broken", "SKILL.md"), "---\nname: [unclosed\n---\nBody\n");
    let reads = 0;
    expect(await waitForEngineSkillChanges(root, async () => { reads++; return { data: [] }; })).toBe(true);
    expect(reads).toBe(1);
  });
});

test("an unreadable or non-converging catalog ends the wait without throwing", async () => {
  await withWorkspace(async (root) => {
    const skill = join(root, ".opencode", "skills", "notes", "SKILL.md");
    await writeSkill(skill, "---\nname: notes\n---\nCurrent body\n");
    expect(await waitForEngineSkillChanges(root, async () => { throw new Error("HTTP 503"); })).toBe(false);
    expect(await waitForEngineSkillChanges(root, async () => ({ unexpected: true }))).toBe(false);
    const started = Date.now();
    expect(await waitForEngineSkillChanges(root, async () => ({ data: [] }), 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
