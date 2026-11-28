import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import {
  assertBranchName,
  assertRepositoryPath,
  CloudCodingChangeRefusal,
  gitBlobSha,
  gitCommitSha,
  gitIdentityName,
  gitTreeSha,
  normalizeCommitMessage,
  planCommitTrees,
  type GitTreeEntry,
  type PlannedFile,
} from "../src/cloud-coding/gateway/git-objects.js"

const identity = { name: "Maya Chen", email: "1001+maya-chen@users.noreply.github.com" }
const commitTime = 1_795_000_000
let repo = ""
let baseSha = ""
let baseTreeSha = ""

function git(args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: repo,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_AUTHOR_DATE: `${commitTime} +0000`,
      GIT_COMMITTER_DATE: `${commitTime} +0000`,
    },
  }).trim()
}

function write(file: string, content: string, executable = false) {
  const target = path.join(repo, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  if (executable) chmodSync(target, 0o755)
}

async function readTree(treeSha: string): Promise<GitTreeEntry[]> {
  const output = git(["ls-tree", treeSha])
  if (!output) return []
  return output.split("\n").map((line) => {
    const [meta = "", name = ""] = line.split("\t")
    const [mode = "", , sha = ""] = meta.split(" ")
    return { mode, name, sha }
  })
}

function refusal(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    if (error instanceof CloudCodingChangeRefusal) return error.code
    throw error
  }
  return "accepted"
}

async function planRefusal(files: PlannedFile[]): Promise<string> {
  try {
    await planCommitTrees({ baseTreeSha, files, readTree })
  } catch (error) {
    if (error instanceof CloudCodingChangeRefusal) return error.code
    throw error
  }
  return "accepted"
}

before(() => {
  repo = mkdtempSync(path.join(tmpdir(), "cloud-coding-git-"))
  git(["init", "--quiet", "--initial-branch=main"])
  write("README.md", "# Storefront\n")
  write("src/checkout/total.ts", "export const total = (cents: number) => cents\n")
  write("src/checkout/tax.ts", "export const tax = 0.2\n")
  write("src/index.ts", "export * from './checkout/total'\n")
  write("scripts/build.sh", "#!/bin/sh\necho build\n", true)
  write("docs/returns/policy.md", "Returns within 30 days.\n")
  write("src-extra.txt", "sorts between src and src/\n")
  git(["add", "-A"])
  git(["commit", "--quiet", "-m", "Initial commit"])
  baseSha = git(["rev-parse", "HEAD"])
  baseTreeSha = git(["rev-parse", "HEAD^{tree}"])
})

after(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

test("blob, tree and commit SHAs match git's own", async () => {
  const content = Buffer.from("export const total = (cents: number) => Math.round(cents)\n")
  assert.equal(gitBlobSha(content), git(["hash-object", "--stdin"], content.toString("utf8")))
  assert.equal(gitTreeSha(await readTree(baseTreeSha)), baseTreeSha)
  const message = normalizeCommitMessage("Fix one-cent rounding in checkout total\n\nRound to whole cents.  \n\n")
  const expected = git(["commit-tree", baseTreeSha, "-p", baseSha, "-F", "-"], message)
  assert.equal(gitCommitSha({ treeSha: baseTreeSha, parentSha: baseSha, identity, time: commitTime, message }), expected)
})

test("a planned change produces the same tree and commit git builds from the same files", async () => {
  const total = "export const total = (cents: number) => Math.round(cents)\n"
  const spec = "import { total } from './total'\n"
  const tool = "#!/bin/sh\necho test\n"
  const plan = await planCommitTrees({
    baseTreeSha,
    readTree,
    files: [
      { path: "src/checkout/total.ts", mode: "100644", blobSha: gitBlobSha(Buffer.from(total)) },
      { path: "src/checkout/__tests__/total.test.ts", mode: "100644", blobSha: gitBlobSha(Buffer.from(spec)) },
      { path: "tools/test.sh", mode: "100755", blobSha: gitBlobSha(Buffer.from(tool)) },
      { path: "docs/returns/policy.md", deleted: true },
      { path: "src/checkout/tax.ts", mode: "100644", blobSha: gitBlobSha(Buffer.from("export const tax = 0.2\n")) },
    ],
  })

  write("src/checkout/total.ts", total)
  write("src/checkout/__tests__/total.test.ts", spec)
  write("tools/test.sh", tool, true)
  rmSync(path.join(repo, "docs"), { recursive: true })
  git(["add", "-A"])
  const expectedTree = git(["write-tree"])
  const message = normalizeCommitMessage("Fix one-cent rounding in checkout total")
  const expectedCommit = git(["commit-tree", expectedTree, "-p", baseSha, "-F", "-"], message)

  assert.equal(plan.rootTreeSha, expectedTree)
  assert.equal(gitCommitSha({ treeSha: plan.rootTreeSha, parentSha: baseSha, identity, time: commitTime, message }), expectedCommit)
  assert.deepEqual(plan.changes, [
    { path: "docs/returns/policy.md", change: "deleted" },
    { path: "src/checkout/__tests__/total.test.ts", change: "added" },
    { path: "src/checkout/total.ts", change: "modified" },
    { path: "tools/test.sh", change: "added" },
  ])
  for (const tree of plan.newTrees) assert.equal(git(["cat-file", "-t", tree.sha]), "tree")
  const created = new Set<string>()
  for (const tree of plan.newTrees) {
    for (const entry of tree.entries) {
      if (entry.mode === "40000" && plan.newTrees.some((candidate) => candidate.sha === entry.sha)) assert.ok(created.has(entry.sha), "child trees come before their parents")
    }
    created.add(tree.sha)
  }
  git(["reset", "--quiet", "--hard", baseSha])
})

test("a folder can be replaced by a file in one change", async () => {
  const plan = await planCommitTrees({
    baseTreeSha,
    readTree,
    files: [
      { path: "docs/returns/policy.md", deleted: true },
      { path: "docs", mode: "100644", blobSha: gitBlobSha(Buffer.from("See the website.\n")) },
    ],
  })
  rmSync(path.join(repo, "docs"), { recursive: true })
  write("docs", "See the website.\n")
  git(["add", "-A"])
  assert.equal(plan.rootTreeSha, git(["write-tree"]))
  git(["reset", "--quiet", "--hard", baseSha])
})

test("changes that cannot be one clean commit are refused", async () => {
  const blobSha = gitBlobSha(Buffer.from("x\n"))
  assert.equal(await planRefusal([{ path: "src/checkout/tax.ts", mode: "100644", blobSha: gitBlobSha(Buffer.from("export const tax = 0.2\n")) }]), "no_changes")
  assert.equal(await planRefusal([{ path: "docs/missing.md", deleted: true }]), "path_refused")
  assert.equal(await planRefusal([{ path: "src/checkout", deleted: true }]), "path_refused")
  assert.equal(await planRefusal([{ path: "README.md/notes.md", mode: "100644", blobSha }]), "path_refused")
  assert.equal(await planRefusal([{ path: "src/checkout", mode: "100644", blobSha }]), "path_refused")
  assert.equal(await planRefusal([{ path: "a.txt", mode: "100644", blobSha }, { path: "a.txt", deleted: true }]), "path_refused")
  assert.equal(await planRefusal([{ path: ".github/workflows/ci.yml", mode: "100644", blobSha }]), "workflow_files_refused")
})

test("paths outside the working tree and workflow files are refused", () => {
  for (const bad of ["", "/etc/passwd", "../outside", "src/../../outside", "src//a.ts", "./a.ts", ".git/config", "src/.GIT/hooks/pre-push", "src\\a.ts", "dir/", "a\nb"]) {
    assert.equal(refusal(() => assertRepositoryPath(bad)), "path_refused", bad)
  }
  for (const workflow of [".github/workflows/ci.yml", ".GitHub/Workflows/deploy.yaml", ".github/workflows"]) {
    assert.equal(refusal(() => assertRepositoryPath(workflow)), "workflow_files_refused", workflow)
  }
  for (const fine of ["README.md", ".github/CODEOWNERS", ".github/workflows-notes.md", "src/checkout/total.ts", ".gitignore", "docs/.gitkeep"]) {
    assert.equal(refusal(() => assertRepositoryPath(fine)), "accepted", fine)
  }
})

test("only plain branch names are accepted", () => {
  for (const bad of ["", "refs/heads/main", "-force", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "/a", "a/", "a//b", "a.", ".hidden", "a/.b", "a.lock", "a.lock/b", "a@{0}", "@", "HEAD", "x".repeat(201)]) {
    assert.equal(refusal(() => assertBranchName(bad)), "invalid_branch", bad)
  }
  for (const fine of ["openwork/fix-rounding", "fix-rounding", "feature/checkout/one-cent", "v1.2-fix"]) {
    assert.equal(refusal(() => assertBranchName(fine)), "accepted", fine)
  }
  for (const name of ["openwork/fix-rounding", "v1.2-fix"]) {
    assert.doesNotThrow(() => git(["check-ref-format", "--branch", name]))
  }
})

test("identity names and messages are stored the way git stores them", () => {
  assert.equal(gitIdentityName("  Maya <Chen>\n", "maya-chen"), "Maya Chen")
  assert.equal(gitIdentityName("<>", "maya-chen"), "maya-chen")
  assert.equal(normalizeCommitMessage("Title\r\n\r\nBody\r\n\n\n"), "Title\n\nBody\n")
})
