import assert from "node:assert/strict"
import { test } from "node:test"
import type { GithubDiscoveryTreeEntry } from "../src/routes/org/plugin-system/github-discovery.js"
import { githubSkillBundleRevision, githubSkillFolderEntries, readGithubSkillFiles, selectGithubSkillFiles } from "../src/routes/org/plugin-system/github-skill-files.js"
import { SKILL_FILE_MAX_BYTES } from "../src/skill-files.js"

const sourcePath = "skills/example/SKILL.md"

function blob(path: string, options: Partial<GithubDiscoveryTreeEntry> = {}): GithubDiscoveryTreeEntry {
  return { id: path, kind: "blob", path, sha: "original", size: 10, ...options }
}

function supportingFiles(treeEntries: GithubDiscoveryTreeEntry[]) {
  return selectGithubSkillFiles(githubSkillFolderEntries({ sourcePath, treeEntries })).entries
}

test("a GitHub skill reads only eligible text files from its own folder", async () => {
  const entries = supportingFiles([
    blob(sourcePath),
    blob("README.md"),
    blob("skills/other/SKILL.md"),
    blob("skills/example/references/guide.md"),
    blob("skills/example/references/large.md", { size: SKILL_FILE_MAX_BYTES + 1 }),
    blob("skills/example/references/link.md", { mode: "120000" }),
    blob("skills/example/assets/image.png"),
  ])
  const loaded = await readGithubSkillFiles(entries, async (selected) => {
    assert.deepEqual(selected.map((entry) => entry.discoveryPath), [
      "skills/example/assets/image.png",
      "skills/example/references/guide.md",
    ])
    return ["\0", "reference text"]
  })
  assert.deepEqual(loaded.leftOut, ["assets/image.png"])
  assert.deepEqual(loaded.files.map((file) => [file.path, Buffer.from(file.bytes).toString()]), [["references/guide.md", "reference text"]])
})

test("companion-only edits, renames and removals change the skill revision", () => {
  const guide = blob("skills/example/references/guide.md")
  const notes = blob("skills/example/references/notes.md")
  const revision = (...entries: GithubDiscoveryTreeEntry[]) => githubSkillBundleRevision("unchanged-entrypoint", supportingFiles(entries))
  const original = revision(guide, notes)
  assert.equal(revision(notes, guide), original)
  assert.equal(revision(guide, notes, blob("unrelated.md")), original)
  assert.notEqual(revision({ ...guide, sha: "new-content" }, notes), original)
  assert.notEqual(revision(blob("skills/example/references/renamed.md"), notes), original)
  assert.notEqual(revision(notes), original)
  assert.notEqual(revision(), "unchanged-entrypoint")
})

test("a failed supporting-file fetch rejects the entire file set", async () => {
  const entries = supportingFiles([blob("skills/example/references/guide.md")])
  await assert.rejects(readGithubSkillFiles(entries, async () => { throw new Error("GitHub unavailable") }), /GitHub unavailable/)
})
