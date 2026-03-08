import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { listSkills, getSkillContent } from "./skills.js";
import type { SkillItem } from "./types.js";

describe("listSkills", () => {
  const testDir = join(import.meta.dir, "test-skills-fixture");
  const projectSkillsDir = join(testDir, ".opencode", "skills");

  beforeEach(async () => {
    await mkdir(projectSkillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns empty array when no skills exist", async () => {
    const skills = await listSkills(testDir, false);
    // Should still include builtin skills
    expect(skills.length).toBeGreaterThanOrEqual(1);
  });

  test("includes project skills", async () => {
    const skillDir = join(projectSkillsDir, "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: test-skill
description: A test skill
---
Test content
`,
    );

    const skills = await listSkills(testDir, false);
    const testSkill = skills.find((s) => s.name === "test-skill");
    expect(testSkill).toBeDefined();
    expect(testSkill?.description).toBe("A test skill");
    expect(testSkill?.scope).toBe("project");
  });

  test("deduplicates skills by name", async () => {
    const skillDir = join(projectSkillsDir, "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: test-skill
description: Project version
---
`,
    );

    // Create global skill with same name
    const globalSkillDir = join(testDir, "global-skills", "test-skill");
    await mkdir(globalSkillDir, { recursive: true });
    await writeFile(
      join(globalSkillDir, "SKILL.md"),
      `---
name: test-skill
description: Global version
---
`,
    );

    const skills = await listSkills(testDir, false);
    const testSkills = skills.filter((s) => s.name === "test-skill");
    expect(testSkills.length).toBe(1);
    // Project skill takes precedence
    expect(testSkills[0]?.scope).toBe("project");
  });
});

describe("builtin skills", () => {
  test("includes past-conversations skill", async () => {
    const skills = await listSkills("/tmp", false);
    const pastConversations = skills.find(
      (s) => s.name === "past-conversations",
    );
    expect(pastConversations).toBeDefined();
    expect(pastConversations?.scope).toBe("global");
    expect(pastConversations?.description).toContain("past conversations");
    expect(pastConversations?.builtin).toBe(true);
  });

  test("past-conversations has trigger phrases in description", async () => {
    const skills = await listSkills("/tmp", false);
    const pastConversations = skills.find(
      (s) => s.name === "past-conversations",
    );
    expect(pastConversations).toBeDefined();

    // Check for trigger phrases
    const desc = pastConversations?.description ?? "";
    expect(desc).toContain("Triggers when user mentions");
    expect(desc).toContain("what did we discuss before");
    expect(desc).toContain("recall our previous conversation");
  });

  test("past-conversations skill path points to builtin directory", async () => {
    const skills = await listSkills("/tmp", false);
    const pastConversations = skills.find(
      (s) => s.name === "past-conversations",
    );
    expect(pastConversations).toBeDefined();
    // Path should contain builtin-skills or use builtin:// protocol
    const path = pastConversations?.path ?? "";
    expect(path.includes("builtin-skills") || path.startsWith("builtin://")).toBe(true);
  });

  test("getSkillContent returns content for builtin skill", async () => {
    const skills = await listSkills("/tmp", false);
    const pastConversations = skills.find(
      (s) => s.name === "past-conversations",
    );
    expect(pastConversations).toBeDefined();

    const content = await getSkillContent(pastConversations!);
    expect(content).toContain("past-conversations");
    expect(content).toContain("OpenCode database");
    expect(content).toContain("sqlite3");
  });
});
