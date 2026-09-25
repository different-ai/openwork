import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildOpenWorkV2Instructions, nativeSkillBody, waitForOpenWorkV2Skills } from "./opencode-v2-instructions.js";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openwork-v2-skills-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("native-valid skills with a directory/name mismatch or no description do not block admission", async () => {
  await withWorkspace(async (root) => {
    const mismatch = join(root, ".opencode", "skills", "release-notes", "SKILL.md");
    const bare = join(root, ".claude", "skills", "nested", "Bare_Skill", "SKILL.md");
    const flat = join(root, ".opencode", "skills", "quick.md");
    await mkdir(join(mismatch, ".."), { recursive: true });
    await mkdir(join(bare, ".."), { recursive: true });
    await writeFile(mismatch, "---\nname: Release Notes Writer\n---\n\nWrite release notes.\n");
    await writeFile(bare, "No frontmatter at all.\n");
    await writeFile(flat, "---\ndescription: quick\n---\nQuick body\n");
    let reads = 0;
    await waitForOpenWorkV2Skills(root, async () => {
      reads++;
      return { data: [
        { id: "release-notes", name: "Release Notes Writer", location: mismatch, content: "\nWrite release notes.\n" },
        { id: "Bare_Skill", name: "Bare_Skill", location: bare, content: "No frontmatter at all.\n" },
        { id: "quick", name: "quick", description: "quick", location: flat, content: "Quick body\n" },
        { id: "plugin-skill", name: "plugin-skill", location: join(root, ".opencode", "plugins", "x", "SKILL.md"), content: "unrelated" },
      ] };
    });
    expect(reads).toBe(1);
  });
});

test("content edits and removals under managed roots are awaited by body, not by OpenWork validation", async () => {
  await withWorkspace(async (root) => {
    const skill = join(root, ".opencode", "skills", "notes", "SKILL.md");
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(skill, "---\nname: notes\n---\nCurrent body\n");
    const deleted = join(root, ".opencode", "skills", "gone", "SKILL.md");
    let reads = 0;
    await waitForOpenWorkV2Skills(root, async () => {
      reads++;
      return reads === 1
        ? { data: [{ id: "notes", name: "notes", location: skill, content: "Old body" }, { id: "gone", name: "gone", location: deleted, content: "x" }] }
        : { data: [{ id: "notes", name: "notes", location: skill, content: "Current body\n" }] };
    });
    expect(reads).toBe(2);
  });
});

test("skipped native files (malformed frontmatter) are neither expected nor treated as removed", async () => {
  await withWorkspace(async (root) => {
    const broken = join(root, ".opencode", "skills", "broken", "SKILL.md");
    await mkdir(join(broken, ".."), { recursive: true });
    await writeFile(broken, "---\nname: [unclosed\n---\nBody\n");
    expect(nativeSkillBody("---\nname: 3\n---\nx")).toBeNull();
    expect(nativeSkillBody("---\nslash: yes\n---\nx")).toBeNull();
    expect(nativeSkillBody("plain")).toBe("plain");
    let reads = 0;
    await waitForOpenWorkV2Skills(root, async () => { reads++; return { data: [] }; });
    expect(reads).toBe(1);
  });
});

test("v2 discovers remote skills on demand and keeps local skills native", () => {
  const connected = buildOpenWorkV2Instructions(true);
  expect(connected.operatingInstructions).toContain("remote skills");
  expect(connected.skillInstructions).toContain("OpenWork Connect");
  expect(connected.skillInstructions).toContain("on demand");
  expect(JSON.stringify(connected)).not.toContain("<available_remote_skills>");
});

test("a skill installed in two agent folders is served once by the engine and does not block admission", async () => {
  await withWorkspace(async (root) => {
    // Same skill copied into .agents/skills and .claude/skills: the engine
    // serves one skill per name, so the .claude copy is shadowed, not missing.
    const body = "---\nname: mix-tape\ndescription: Local playground\n---\n\nMaintain the playground.\n";
    const agents = join(root, ".agents", "skills", "mix-tape", "SKILL.md");
    const claude = join(root, ".claude", "skills", "mix-tape", "SKILL.md");
    for (const path of [agents, claude]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, body);
    }
    let reads = 0;
    await waitForOpenWorkV2Skills(root, async () => {
      reads++;
      return { data: [{ id: "mix-tape", name: "mix-tape", location: agents, content: "Maintain the playground." }] };
    });
    expect(reads).toBe(1);
  });
});
