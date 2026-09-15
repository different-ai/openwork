import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenWorkV2Instructions, nativeSkillBody, waitForNativeOpenWorkV2Skills, waitForOpenWorkV2Skills } from "./opencode-v2-instructions.js";

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
    for (const wait of [waitForOpenWorkV2Skills, waitForNativeOpenWorkV2Skills]) {
      let reads = 0;
      await wait(root, async () => {
        reads++;
        return { data: [
          { id: "release-notes", name: "Release Notes Writer", location: mismatch, content: "\nWrite release notes.\n" },
          { id: "Bare_Skill", name: "Bare_Skill", location: bare, content: "No frontmatter at all.\n" },
          { id: "quick", name: "quick", description: "quick", location: flat, content: "Quick body\n" },
          { id: "plugin-skill", name: "plugin-skill", location: join(root, ".opencode", "plugins", "x", "SKILL.md"), content: "unrelated" },
        ] };
      });
      expect(reads).toBe(1);
    }
  });
});

test("content edits and removals under managed roots are awaited by body", async () => {
  await withWorkspace(async (root) => {
    const skill = join(root, ".opencode", "skills", "notes", "SKILL.md");
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(skill, "---\nname: notes\n---\nCurrent body\n");
    const deleted = join(root, ".opencode", "skills", "gone", "SKILL.md");
    for (const wait of [waitForOpenWorkV2Skills, waitForNativeOpenWorkV2Skills]) {
      let reads = 0;
      await wait(root, async () => ++reads === 1
        ? { data: [{ id: "notes", location: skill, content: "Old body" }, { id: "gone", location: deleted, content: "x" }] }
        : { data: [{ id: "notes", location: skill, content: "Current body\n" }] });
      expect(reads).toBe(2);
    }
  });
});

test("native-skipped malformed workspace files are not required for admission", async () => {
  await withWorkspace(async (root) => {
    const broken = join(root, ".opencode", "skills", "broken", "SKILL.md");
    await mkdir(join(broken, ".."), { recursive: true });
    await writeFile(broken, "---\nname: [unclosed\n---\nBody\n");
    expect(nativeSkillBody("---\nname: 3\n---\nx")).toBeNull();
    expect(nativeSkillBody("---\nslash: yes\n---\nx")).toBeNull();
    expect(nativeSkillBody("plain")).toBe("plain");
    for (const wait of [waitForOpenWorkV2Skills, waitForNativeOpenWorkV2Skills]) {
      let reads = 0;
      await wait(root, async () => { reads++; return { data: [] }; });
      expect(reads).toBe(1);
    }
  });
});

test("Cloud readiness returns native ID/source only after exact bodies and stale removal converge", async () => {
  await withWorkspace(async (root) => {
    const cloudRoot = join(root, "state", "cloud-skills");
    const scope = join(cloudRoot, "0123456789abcdef");
    const id = "openwork-cloud-aaaaaaaaaaaaaaaa";
    const location = join(scope, id, "SKILL.md");
    const content = "---\nname: briefing\ndescription: Brief\n---\n\nDo the briefing.\n";
    const stale = join(cloudRoot, "fedcba9876543210", "old", "SKILL.md");
    const uri = "skill://briefing/SKILL.md";
    const authScope = "a".repeat(64);
    const cloud = { root: cloudRoot, state: { root: scope, skills: [{ id, uri, scope: authScope, location, content }] } };
    let reads = 0;
    const readNative = async () => {
      reads++;
      if (reads === 1) return { data: [{ id: "old", location: stale, content: "old" }] };
      if (reads === 2) return { data: [{ id, location, content: "Previous body" }] };
      return { data: [{ id, name: "briefing", location, content: "\nDo the briefing.\n" }] };
    };
    const catalog = await waitForNativeOpenWorkV2Skills(root, readNative, cloud);
    expect(reads).toBe(3);
    expect(catalog.data[0]).toMatchObject({ id, location, source: { type: "openwork-cloud", uri, scope: authScope } });
    reads = 0;
    await waitForOpenWorkV2Skills(root, readNative, cloud);
    expect(reads).toBe(3);
  });
});

test("v2 guidance routes all skills natively without XML or Connect skill prose", () => {
  for (const connected of [true, false]) {
    const baseline = buildOpenWorkV2Instructions(connected);
    for (const value of [baseline, buildOpenWorkV2Instructions(connected, "preview"), buildOpenWorkV2Instructions(connected, "native")]) {
      const text = JSON.stringify(value);
      expect(value).toEqual(baseline);
      expect(text).not.toContain("available_remote_skills");
      expect(text).not.toContain("execute_capability");
      expect(value.operatingInstructions).not.toContain("remote skills");
      expect(value.operatingInstructions).not.toContain("remote skill catalog");
      expect(value.operatingInstructions).toContain("Authorized organization skills are in the native skill catalog");
      expect(value.skillInstructions).not.toContain("provided by OpenWork Connect");
      expect(value.skillInstructions).toContain("openwork-cloud-");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(7 * 1024);
    }
  }
});
