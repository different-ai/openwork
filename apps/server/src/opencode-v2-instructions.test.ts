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

test("materialized cloud skills must be present with their bodies and stale cloud entries gone", async () => {
  await withWorkspace(async (root) => {
    const cloudRoot = join(root, "state", "cloud-skills");
    const scope = join(cloudRoot, "0123456789abcdef");
    const location = join(scope, "openwork-cloud-aaaaaaaaaaaaaaaa", "SKILL.md");
    const content = "---\nname: customer-briefing\ndescription: Brief\n---\n\nDo the briefing.\n";
    const stale = join(cloudRoot, "fedcba9876543210", "openwork-cloud-bbbbbbbbbbbbbbbb", "SKILL.md");
    let reads = 0;
    await waitForOpenWorkV2Skills(root, async () => {
      reads++;
      if (reads === 1) return { data: [{ id: "openwork-cloud-bbbbbbbbbbbbbbbb", name: "old", location: stale, content: "old" }] };
      if (reads === 2) return { data: [{ id: "openwork-cloud-aaaaaaaaaaaaaaaa", name: "customer-briefing", location, content: "Previous body" }] };
      return { data: [{ id: "openwork-cloud-aaaaaaaaaaaaaaaa", name: "customer-briefing", location, content: "\nDo the briefing.\n" }] };
    }, { root: cloudRoot, state: { root: scope, skills: [{ id: "openwork-cloud-aaaaaaaaaaaaaaaa", uri: "skill://customer-briefing/SKILL.md", location, content }] } });
    expect(reads).toBe(3);
  });
});

test("v2 guidance routes organization skills through the native catalog, not Connect", () => {
  for (const connected of [true, false]) {
    const value = buildOpenWorkV2Instructions(connected);
    expect(value.operatingInstructions).not.toContain("remote skills");
    expect(value.operatingInstructions).not.toContain("remote skill catalog");
    expect(value.operatingInstructions).toContain("Authorized organization skills are in the native skill catalog");
    expect(value.skillInstructions).not.toContain("provided by OpenWork Connect");
    expect(value.skillInstructions).toContain("openwork-cloud-");
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(7 * 1024);
  }
});
