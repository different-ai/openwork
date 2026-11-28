import { z } from "zod"
import type { CloudCodingAppConfig } from "../config.js"
import { cloudCodingGithubRequest, CloudCodingGithubError } from "../github-api.js"
import { CloudCodingChangeRefusal, type GitIdentity, type GitTreeEntry } from "./git-objects.js"

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const objectSchema = z.object({ sha })
const refSchema = z.object({ object: objectSchema })
const commitSchema = z.object({ tree: objectSchema })
const treeSchema = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string().regex(/^[^/\0]+$/), mode: z.enum(["040000", "100644", "100755", "120000", "160000"]), sha })) })
const pullSchema = z.object({ number: z.number().int().positive(), html_url: z.string().url(), title: z.string(), state: z.enum(["open", "closed"]), merged_at: z.string().nullable(), closed_at: z.string().nullable(), created_at: z.string().datetime({ offset: true }), head: z.object({ sha, ref: z.string() }), base: z.object({ ref: z.string() }) })
export type GithubPullRequest = z.infer<typeof pullSchema>

export function githubRefused(message = "GitHub could not complete the request. Try again in a moment.") {
  return new CloudCodingChangeRefusal("github_refused", message)
}

export function branchExists() {
  return new CloudCodingChangeRefusal("branch_exists", "That branch already exists. Choose a new branch name and ask for a new approval.")
}

export function githubGit(input: { config: CloudCodingAppConfig; token: string; fullName: string }) {
  const path = `/repos/${input.fullName.split("/").map(encodeURIComponent).join("/")}`
  const owner = input.fullName.split("/")[0]
  const read = <T>(suffix: string, schema: z.ZodType<T>, allowStatuses?: number[]) => cloudCodingGithubRequest({ ...input, path: path + suffix, schema, allowStatuses })
  const write = async <T>(suffix: string, body: unknown, schema: z.ZodType<T>, allowStatuses?: number[]) =>
    (await cloudCodingGithubRequest({ ...input, path: path + suffix, method: "POST", body, schema, allowStatuses })).data
  return {
    async readCommit(sha: string) {
      const result = await read(`/git/commits/${sha}`, commitSchema, [404, 409, 422])
      if (!result.data) throw new CloudCodingChangeRefusal("base_not_found", "GitHub could not find the commit this work started from. Start again from the latest code.")
      return result.data.tree.sha
    },
    async readTree(sha: string): Promise<GitTreeEntry[]> {
      const { data } = await read(`/git/trees/${sha}`, treeSchema)
      if (!data || data.truncated) throw githubRefused("GitHub did not return the complete list of files in a folder. OpenWork cannot safely push this change.")
      return data.tree.map(({ path: name, mode, sha }) => ({ name, mode, sha }))
    },
    async readBranch(branch: string) {
      const { data } = await read(`/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, refSchema, [404])
      return data?.object.sha ?? null
    },
    async createBlob(content: Uint8Array) {
      return (await write("/git/blobs", { content: Buffer.from(content).toString("base64"), encoding: "base64" }, objectSchema))?.sha
    },
    async createTree(entries: readonly GitTreeEntry[]) {
      const tree = entries.map(({ name: path, mode, sha }) => {
        if (mode === "40000" || mode === "040000") return { path, mode: "040000", type: "tree", sha }
        return { path, mode, type: mode === "160000" ? "commit" : "blob", sha }
      })
      return (await write("/git/trees", { tree }, objectSchema))?.sha
    },
    async createCommit(input: { treeSha: string; baseSha: string; time: number; identity: GitIdentity; message: string }) {
      const person = { ...input.identity, date: new Date(input.time * 1000).toISOString() }
      return (await write("/git/commits", { message: input.message, tree: input.treeSha, parents: [input.baseSha], author: person, committer: person }, objectSchema))?.sha
    },
    async createRef(branch: string, sha: string) {
      const data = await write("/git/refs", { ref: `refs/heads/${branch}`, sha }, refSchema, [422])
      if (!data) throw branchExists()
      if (data.object.sha !== sha) throw new CloudCodingGithubError(502)
    },
    async openPullRequest(input: { title: string; branch: string; base: string; body: string | null }) {
      return write("/pulls", { title: input.title, head: input.branch, base: input.base, body: input.body ?? "" }, pullSchema, [422])
    },
    async findPullRequest(input: { branch: string; base: string; headSha: string }) {
      const { data } = await read(`/pulls?${new URLSearchParams({ head: `${owner}:${input.branch}`, state: "all" })}`, z.array(pullSchema))
      return data?.find(pr => pr.head.ref === input.branch && pr.head.sha === input.headSha && pr.base.ref === input.base) ?? null
    },
  }
}
