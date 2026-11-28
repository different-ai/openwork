import { checkSkillFiles, isSkillFileText, selectSkillFilesBySize, sha256Hex } from "../../../skill-files.js"
import type { GithubDiscoveryTreeEntry } from "./github-discovery.js"

export function githubSkillFolderEntries(input: { sourcePath: string; treeEntries: GithubDiscoveryTreeEntry[] }) {
  const directory = input.sourcePath === "SKILL.md" ? "" : input.sourcePath.endsWith("/SKILL.md")
    ? input.sourcePath.slice(0, -"SKILL.md".length)
    : null
  if (directory === null) return []
  return input.treeEntries
    .filter((entry) => entry.kind === "blob" && entry.mode !== "120000" && entry.path.startsWith(directory) && entry.path !== input.sourcePath)
    .map((entry) => ({ discoveryPath: entry.path, path: entry.path.slice(directory.length), sha: entry.sha, size: entry.size }))
}

type FolderEntry = ReturnType<typeof githubSkillFolderEntries>[number]

export function selectGithubSkillFiles(entries: FolderEntry[]) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const { included, leftOut } = selectSkillFilesBySize(entries)
  return { entries: included.flatMap((path) => byPath.get(path) ?? []), leftOut }
}

export async function readGithubSkillFiles(entries: FolderEntry[], readTexts: (entries: FolderEntry[]) => Promise<(string | null)[]>) {
  const texts = await readTexts(entries)
  const files = []
  const leftOut = []
  for (const [index, { path }] of entries.entries()) {
    const text = texts[index]
    if (typeof text === "string" && isSkillFileText(text)) files.push({ path, text })
    else leftOut.push(path)
  }
  const checked = checkSkillFiles(files)
  if ("files" in checked) return { files: checked.files, leftOut }
  return { files: [], leftOut: entries.map((entry) => entry.path) }
}

export function githubSkillBundleRevision(entrypointSha: string, supportingFiles: FolderEntry[]) {
  const files = [...supportingFiles].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, sha }) => [path, sha])
  return `skill:${sha256Hex(new Uint8Array(Buffer.from(JSON.stringify([entrypointSha, files]))))}`
}
