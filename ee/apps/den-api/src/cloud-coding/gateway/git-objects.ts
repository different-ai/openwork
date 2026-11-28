import { createHash } from "node:crypto"
import type { CloudCodingFileChange, CloudCodingGatewayRefusal } from "@openwork/types/den/cloud-coding"


export class CloudCodingChangeRefusal extends Error {
  constructor(readonly code: CloudCodingGatewayRefusal, message: string) {
    super(message)
    this.name = "CloudCodingChangeRefusal"
  }
}

const TREE_MODE = "40000"
const SHA_PATTERN = /^[0-9a-f]{40}$/

export type GitTreeEntry = { mode: string; name: string; sha: string }
export type GitTreeReader = (treeSha: string) => Promise<readonly GitTreeEntry[]>

export type PlannedFile =
  | { path: string; mode: "100644" | "100755"; blobSha: string }
  | { path: string; deleted: true }

export type PlannedTree = { sha: string; entries: GitTreeEntry[] }

export type CommitTreePlan = {
  rootTreeSha: string
  newTrees: PlannedTree[]
  changes: CloudCodingFileChange[]
}

function gitObjectSha(type: "blob" | "tree" | "commit", body: Uint8Array): string {
  return createHash("sha1").update(`${type} ${body.byteLength}\0`).update(body).digest("hex")
}

export function gitBlobSha(content: Uint8Array): string {
  return gitObjectSha("blob", content)
}

function normalizeMode(mode: string): string {
  return mode.replace(/^0+/, "")
}

function isTree(entry: Pick<GitTreeEntry, "mode">): boolean {
  return normalizeMode(entry.mode) === TREE_MODE
}

function treeSortKey(entry: GitTreeEntry): Buffer {
  return Buffer.from(isTree(entry) ? `${entry.name}/` : entry.name, "utf8")
}

export function sortGitTreeEntries(entries: readonly GitTreeEntry[]): GitTreeEntry[] {
  return [...entries].sort((left, right) => Buffer.compare(treeSortKey(left), treeSortKey(right)))
}

export function gitTreeSha(entries: readonly GitTreeEntry[]): string {
  const parts: Buffer[] = []
  for (const entry of sortGitTreeEntries(entries)) {
    if (!SHA_PATTERN.test(entry.sha)) throw new Error("git_tree_entry_sha_invalid")
    parts.push(Buffer.from(`${normalizeMode(entry.mode)} ${entry.name}\0`, "utf8"), Buffer.from(entry.sha, "hex"))
  }
  return gitObjectSha("tree", Buffer.concat(parts))
}

export type GitIdentity = { name: string; email: string }

export function gitIdentityName(name: string, fallback: string): string {
  const cleaned = name.replace(/[<>\r\n\0]/g, "").trim()
  return cleaned.length > 0 ? cleaned : fallback
}

export function normalizeCommitMessage(message: string): string {
  return `${message.replace(/\r\n?/g, "\n").trimEnd()}\n`
}

export function gitCommitSha(input: { treeSha: string; parentSha: string; identity: GitIdentity; time: number; message: string }): string {
  const stamp = `${input.identity.name} <${input.identity.email}> ${input.time} +0000`
  const body = `tree ${input.treeSha}\nparent ${input.parentSha}\nauthor ${stamp}\ncommitter ${stamp}\n\n${input.message}`
  return gitObjectSha("commit", Buffer.from(body, "utf8"))
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const WORKFLOW_PREFIX = ".github/workflows/"

export function assertRepositoryPath(path: string): void {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || CONTROL_CHARACTERS.test(path)) {
    throw new CloudCodingChangeRefusal("path_refused", `"${path}" is not a file path inside the repository.`)
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git") {
      throw new CloudCodingChangeRefusal("path_refused", `"${path}" is not a file path inside the repository.`)
    }
  }
  if (`${path.toLowerCase()}/`.startsWith(WORKFLOW_PREFIX)) {
    throw new CloudCodingChangeRefusal(
      "workflow_files_refused",
      `OpenWork can't change GitHub Actions workflows ("${path}"). Leave files under .github/workflows out of this change and tell the person to edit them by hand.`,
    )
  }
}

const BRANCH_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/

export function assertBranchName(branch: string): void {
  const refuse = () => {
    throw new CloudCodingChangeRefusal("invalid_branch", `"${branch}" can't be used as a branch name. Use letters, numbers, dashes and slashes, for example openwork/fix-rounding.`)
  }
  if (branch.length === 0 || branch.length > 200 || branch === "@" || branch === "HEAD") refuse()
  if (branch.startsWith("refs/") || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")) refuse()
  if (branch.includes("..") || branch.includes("//") || branch.includes("@{") || BRANCH_FORBIDDEN.test(branch)) refuse()
  for (const segment of branch.split("/")) {
    if (segment.startsWith(".") || segment.endsWith(".lock")) refuse()
  }
}

type TreeNode = {
  originalSha: string | null
  entries: Map<string, { mode: string; sha: string; node: TreeNode | null }> | null
  dirty: boolean
}

function emptyNode(): TreeNode {
  return { originalSha: null, entries: new Map(), dirty: true }
}

async function loadedEntries(node: TreeNode, readTree: GitTreeReader) {
  if (node.entries) return node.entries
  if (node.originalSha === null) throw new Error("git_tree_node_unloaded")
  const entries = new Map<string, { mode: string; sha: string; node: TreeNode | null }>()
  for (const entry of await readTree(node.originalSha)) {
    entries.set(entry.name, { mode: normalizeMode(entry.mode), sha: entry.sha, node: null })
  }
  node.entries = entries
  return entries
}

function emptied(node: TreeNode | null): boolean {
  if (!node?.entries) return false
  for (const entry of node.entries.values()) {
    if (entry.mode !== TREE_MODE || !emptied(entry.node)) return false
  }
  return true
}

function conflict(path: string): never {
  throw new CloudCodingChangeRefusal("path_refused", `"${path}" can't be changed this way because a file and a folder would share a name. Delete the old path in the same change.`)
}

export async function planCommitTrees(input: { baseTreeSha: string; files: readonly PlannedFile[]; readTree: GitTreeReader }): Promise<CommitTreePlan> {
  const root: TreeNode = { originalSha: input.baseTreeSha, entries: null, dirty: false }
  const changes = new Map<string, CloudCodingFileChange["change"]>()
  const seen = new Set<string>()
  for (const file of input.files) {
    assertRepositoryPath(file.path)
    if (seen.has(file.path)) throw new CloudCodingChangeRefusal("path_refused", `"${file.path}" is listed more than once.`)
    seen.add(file.path)
  }

  const walk = async (path: string, create: boolean): Promise<{ parents: TreeNode[]; name: string } | null> => {
    const segments = path.split("/")
    const name = segments[segments.length - 1] ?? ""
    const parents: TreeNode[] = [root]
    let node = root
    for (const segment of segments.slice(0, -1)) {
      const entries = await loadedEntries(node, input.readTree)
      const entry = entries.get(segment)
      if (!entry) {
        if (!create) return null
        const child = emptyNode()
        entries.set(segment, { mode: TREE_MODE, sha: "", node: child })
        node = child
      } else if (entry.mode !== TREE_MODE) {
        if (!create) return null
        conflict(path)
      } else {
        entry.node ??= { originalSha: entry.sha, entries: null, dirty: false }
        node = entry.node
      }
      parents.push(node)
    }
    return { parents, name }
  }

  for (const file of input.files) {
    if (!("deleted" in file)) continue
    const target = await walk(file.path, false)
    const parent = target?.parents[target.parents.length - 1]
    const entries = parent ? await loadedEntries(parent, input.readTree) : null
    const entry = target ? entries?.get(target.name) : undefined
    if (!target || !entries || !entry || entry.mode === TREE_MODE) {
      throw new CloudCodingChangeRefusal("path_refused", `"${file.path}" can't be deleted because it is not a file in the repository.`)
    }
    entries.delete(target.name)
    for (const node of target.parents) node.dirty = true
    changes.set(file.path, "deleted")
  }

  for (const file of input.files) {
    if ("deleted" in file) continue
    if (!SHA_PATTERN.test(file.blobSha)) throw new Error("git_blob_sha_invalid")
    const target = await walk(file.path, true)
    if (!target) conflict(file.path)
    const parent = target.parents[target.parents.length - 1]
    if (!parent) conflict(file.path)
    const entries = await loadedEntries(parent, input.readTree)
    const existing = entries.get(target.name)
    if (existing?.mode === TREE_MODE && !emptied(existing.node)) conflict(file.path)
    if (existing && existing.sha === file.blobSha && existing.mode === file.mode) continue
    entries.set(target.name, { mode: file.mode, sha: file.blobSha, node: null })
    for (const node of target.parents) node.dirty = true
    changes.set(file.path, existing && existing.mode !== TREE_MODE ? "modified" : "added")
  }

  const newTrees = new Map<string, PlannedTree>()
  const finalize = (node: TreeNode): string | null => {
    if (!node.dirty) return node.originalSha
    const entries = node.entries
    if (!entries) throw new Error("git_tree_node_unloaded")
    const result: GitTreeEntry[] = []
    for (const [name, entry] of entries) {
      if (entry.node) {
        const sha = finalize(entry.node)
        if (sha !== null) result.push({ mode: TREE_MODE, name, sha })
      } else {
        result.push({ mode: entry.mode, name, sha: entry.sha })
      }
    }
    if (result.length === 0) return null
    const sorted = sortGitTreeEntries(result)
    const sha = gitTreeSha(sorted)
    if (sha !== node.originalSha) newTrees.set(sha, { sha, entries: sorted })
    return sha
  }

  if (changes.size === 0) {
    throw new CloudCodingChangeRefusal("no_changes", "Nothing changed compared with the branch the work started from, so there is nothing to push.")
  }
  const rootTreeSha = finalize(root)
  if (rootTreeSha === null) {
    throw new CloudCodingChangeRefusal("path_refused", "This change would delete every file in the repository.")
  }
  return {
    rootTreeSha,
    newTrees: [...newTrees.values()],
    changes: [...changes.entries()].map(([path, change]) => ({ path, change })).sort((left, right) => left.path.localeCompare(right.path)),
  }
}
