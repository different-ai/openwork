import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { startFakeGithub, type FakeGithubExtension } from "./cloud-coding-fake-github.js"

function git(repository: string, args: string[], input: string | Uint8Array = ""): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", repository, ...args], { encoding: "buffer", maxBuffer: 16_000_000 }, (error, stdout) => error ? reject(error) : resolve(stdout))
    if (input.length) {
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error) })
      child.stdin?.end(input)
    } else child.stdin?.end()
  })
}
const text = async (repository: string, args: string[], input?: string | Uint8Array) => (await git(repository, args, input)).toString("utf8")
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const identity = z.object({ name: z.string().regex(/^[^\n\r<>\0]+$/), email: z.string().regex(/^[^\n\r<>\0]+$/), date: z.string().datetime({ offset: true }) })
const treeInput = z.object({ tree: z.array(z.object({ path: z.string().regex(/^[^/\0]+$/), mode: z.enum(["040000", "100644", "100755", "120000", "160000"]), type: z.enum(["blob", "tree", "commit"]), sha })) }).strict()
const commitInput = z.object({ message: z.string(), tree: sha, parents: z.array(sha), author: identity, committer: identity })
const pullInput = z.object({ title: z.string(), body: z.string(), head: z.string(), base: z.string() })
const branchRef = (branch: string) => `refs/heads/${branch}`
const findRef = (dir: string, ref: string) => text(dir, ["show-ref", "--verify", "--hash", "--", ref]).then(value => value.trim(), () => null)
const createRef = (dir: string, ref: string, sha: string) => git(dir, ["update-ref", ref, sha, "0".repeat(40)])

async function listTree(dir: string, hash: string, recursive = false) {
  const output = await text(dir, ["ls-tree", "-z", ...(recursive ? ["-r"] : []), hash])
  return output.split("\0").filter(Boolean).map(line => {
    const entry = /^([0-9]+) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line)
    if (!entry) throw new Error("Unexpected git tree entry")
    return { mode: entry[1], type: entry[2], sha: entry[3] ?? "", path: entry[4] ?? "" }
  })
}

type Pull = { number: number; html_url: string; title: string; body: string; state: "open"; merged_at: null; closed_at: null; created_at: string; head: { ref: string; sha: string }; base: { ref: string }; user: { login: string } }
type Attempt = { kind: "installation" | "user" | "unknown"; path: string }

export async function startFakeGithubGit() {
  const folder = await mkdtemp(join(tmpdir(), "cloud-coding-git-"))
  const repositories = new Map<string, string>()
  const pulls = new Map<string, Pull[]>()
  const writes: Attempt[] = []
  const faults = { loseNextRefResponse: false, wrongNextBlobSha: false }

  const extend: FakeGithubExtension = async ({ url, request, raw, response, user, installation, allowedIds, state }) => {
    const json = (status: number, data: unknown) => {
      response.statusCode = status
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(data))
      return true
    }
    const missing = () => json(404, { message: "Not found" })
    const unauthorized = () => {
      response.setHeader("WWW-Authenticate", 'Basic realm="GitHub"')
      return json(401, { message: "Authentication required" })
    }
    const method = request.method
    const smart = /^\/([^/]+\/[^/]+)\.git\/(info\/refs|git-upload-pack)$/.exec(url.pathname)
    if (smart?.[1]) {
      const name = decodeURIComponent(smart[1])
      const dir = repositories.get(name)
      const auth = request.headers.authorization
      const basic = auth?.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : ""
      const credential = basic.startsWith("x-access-token:") ? state.installationTokens.get(basic.slice(15)) : undefined
      const repo = [...state.repositories.values()].find(value => value.full_name === name)
      const installation = credential && state.installations.get(credential.installationId)
      if (!dir || !repo || !credential || credential.expiresAt <= Date.now() || credential.permissions?.contents !== "read" ||
        !installation || installation.suspended_at || !installation.repositoryIds.includes(repo.id) || !credential.repositoryIds?.includes(repo.id)) return unauthorized()
      if (method === "GET" && smart[2] === "info/refs" && url.searchParams.get("service") === "git-upload-pack") {
        const advertisement = await git(dir, ["upload-pack", "--stateless-rpc", "--advertise-refs", "."])
        response.setHeader("content-type", "application/x-git-upload-pack-advertisement")
        response.end(Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), advertisement]))
        return true
      }
      if (method === "POST" && smart[2] === "git-upload-pack") {
        const result = await git(dir, ["upload-pack", "--stateless-rpc", "."], raw)
        response.setHeader("content-type", "application/x-git-upload-pack-result")
        response.end(result)
        return true
      }
      return missing()
    }
    const route = /^\/repos\/([^/]+\/[^/]+)(\/git\/[^?]+|\/pulls)$/.exec(url.pathname)
    if (!route?.[1] || !route[2]) return false
    const name = decodeURIComponent(route[1])
    const path = route[2]
    const repo = [...state.repositories.values()].find(value => value.full_name === name)
    const dir = repositories.get(name)
    if (method === "POST") writes.push({ kind: user ? "user" : installation ? "installation" : "unknown", path: url.pathname })
    if (!repo || !dir || !allowedIds.includes(repo.id)) return missing()
    if (method === "POST" && (!user?.writableRepositoryIds?.includes(repo.id) || repo.archived)) return json(403, { message: "Write access denied" })
    if (method === "GET" && !user && !(installation?.permissions?.contents === "read" && installation.repositoryIds?.includes(repo.id))) return missing()
    if (method === "GET" && path.startsWith("/git/commits/")) {
      const hash = sha.safeParse(path.slice(13))
      if (!hash.success) return missing()
      const tree = await text(dir, ["rev-parse", "--verify", `${hash.data}^{tree}`]).catch(() => null)
      return tree ? json(200, { sha: hash.data, tree: { sha: tree.trim() } }) : missing()
    }
    if (method === "GET" && path.startsWith("/git/trees/")) {
      const hash = sha.safeParse(path.slice(11))
      if (!hash.success) return missing()
      const tree = await listTree(dir, hash.data).catch(() => null)
      return tree ? json(200, { sha: hash.data, tree, truncated: false }) : missing()
    }
    if (method === "GET" && path.startsWith("/git/ref/heads/")) {
      const ref = branchRef(decodeURIComponent(path.slice(15)))
      const hash = await findRef(dir, ref)
      return hash ? json(200, { ref, object: { sha: hash } }) : missing()
    }
    if (method === "POST" && path === "/git/blobs") {
      const input = z.object({ content: z.string(), encoding: z.literal("base64") }).parse(JSON.parse(raw))
      const hash = (await text(dir, ["hash-object", "-w", "--stdin"], Buffer.from(input.content, "base64"))).trim()
      const result = faults.wrongNextBlobSha ? "0".repeat(40) : hash
      faults.wrongNextBlobSha = false
      return json(201, { sha: result })
    }
    if (method === "POST" && path === "/git/trees") {
      const { tree } = treeInput.parse(JSON.parse(raw))
      const input = tree.map(row => `${row.mode} ${row.type} ${row.sha}\t${row.path}\0`).join("")
      return json(201, { sha: (await text(dir, ["mktree", "-z"], input)).trim() })
    }
    if (method === "POST" && path === "/git/commits") {
      const commit = commitInput.parse(JSON.parse(raw))
      const stamp = (person: z.infer<typeof identity>) => `${person.name} <${person.email}> ${Math.floor(Date.parse(person.date) / 1000)} +0000`
      const content = [`tree ${commit.tree}`, ...commit.parents.map(parent => `parent ${parent}`), `author ${stamp(commit.author)}`, `committer ${stamp(commit.committer)}`, "", commit.message].join("\n")
      return json(201, { sha: (await text(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], content)).trim() })
    }
    if (method === "POST" && path === "/git/refs") {
      const input = z.object({ ref: z.string().startsWith("refs/heads/"), sha }).parse(JSON.parse(raw))
      if (await findRef(dir, input.ref)) return json(422, { message: "Reference already exists" })
      const created = await createRef(dir, input.ref, input.sha).then(() => true, () => false)
      if (!created) return json(422, { message: "Reference could not be created" })
      if (faults.loseNextRefResponse) {
        faults.loseNextRefResponse = false
        return json(500, { message: "Response lost" })
      }
      return json(201, { ref: input.ref, object: { sha: input.sha } })
    }
    if (method === "POST" && path === "/pulls" && user) {
      const input = pullInput.parse(JSON.parse(raw))
      const head = await findRef(dir, branchRef(input.head))
      if (!head || !await findRef(dir, branchRef(input.base))) return json(422, { message: "Invalid head or base" })
      const existing = pulls.get(name) ?? []
      if (existing.some(row => row.head.ref === input.head && row.base.ref === input.base)) return json(422, { message: "A pull request already exists" })
      const number = existing.length + 1
      const pull: Pull = { number, html_url: `${url.origin}/${name}/pull/${number}`, title: input.title, body: input.body,
        state: "open", merged_at: null, closed_at: null, created_at: new Date().toISOString(), head: { ref: input.head, sha: head }, base: { ref: input.base }, user: { login: user.login } }
      pulls.set(name, [...existing, pull])
      return json(201, pull)
    }
    if (method === "GET" && path === "/pulls" && user) return json(200, (pulls.get(name) ?? []).filter(row => url.searchParams.get("head") === `${name.split("/")[0]}:${row.head.ref}`))
    return missing()
  }

  const github = await startFakeGithub({ extend })
  function directory(name: string) {
    const dir = repositories.get(name)
    if (!dir) throw new Error("Unknown fake repository")
    return dir
  }

  return {
    ...github, writes, faults, pulls,
    async seedRepository(name: string, files: Record<string, string>) {
      const dir = await mkdtemp(join(folder, "repository-"))
      await git(dir, ["init", "--bare", "--initial-branch=main"])
      await git(dir, ["config", "user.name", "Maya Chen"])
      await git(dir, ["config", "user.email", "1+maya-chen@users.noreply.github.com"])
      const index = []
      for (const [path, contents] of Object.entries(files)) {
        const blob = (await text(dir, ["hash-object", "-w", "--stdin"], contents)).trim()
        index.push(`100644 ${blob}\t${path}\0`)
      }
      await git(dir, ["update-index", "-z", "--index-info"], index.join(""))
      const tree = (await text(dir, ["write-tree"])).trim()
      const base = (await text(dir, ["commit-tree", tree, "-m", "Initial commit"])).trim()
      await createRef(dir, branchRef("main"), base)
      repositories.set(name, dir)
      return base
    },
    async createBranch(name: string, branch: string, sha: string) { await createRef(directory(name), branchRef(branch), sha) },
    async deleteBranch(name: string, branch: string) { await git(directory(name), ["update-ref", "-d", branchRef(branch)]) },
    async readBranch(name: string, branch: string) {
      const dir = directory(name)
      const sha = await findRef(dir, branchRef(branch))
      if (!sha) return null
      const object = await text(dir, ["cat-file", "commit", sha])
      const boundary = object.indexOf("\n\n")
      const headers = object.slice(0, boundary).split("\n")
      const files = await listTree(dir, sha, true)
      return { sha, parent: headers.find(line => line.startsWith("parent "))?.slice(7), author: headers.find(line => line.startsWith("author "))?.slice(7),
        committer: headers.find(line => line.startsWith("committer "))?.slice(10), message: object.slice(boundary + 2),
        files: await Promise.all(files.map(async file => ({ path: file.path, mode: file.mode, contents: await git(dir, ["cat-file", "blob", file.sha]) }))) }
    },
    async close() {
      await github.close()
      await rm(folder, { recursive: true, force: true })
    },
  }
}
