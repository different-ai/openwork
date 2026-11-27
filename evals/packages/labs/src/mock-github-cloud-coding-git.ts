import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

function git(dir: string, args: string[], input: string | Uint8Array = ""): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", dir, ...args], {
      encoding: "buffer", maxBuffer: 16_000_000, timeout: 15_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin?.end(input);
  });
}
const text = async (dir: string, args: string[], input?: string | Uint8Array) => (await git(dir, args, input)).toString();
const ref = (branch: string) => `refs/heads/${branch}`;
const refSha = (dir: string, name: string) => text(dir, ["show-ref", "--verify", "--hash", "--", name]).then(value => value.trim(), () => null);
const createRef = (dir: string, name: string, hash: string) => git(dir, ["update-ref", name, hash, "0".repeat(40)]);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const identity = z.object({ name: z.string().regex(/^[^\n\r<>\0]+$/), email: z.string().regex(/^[^\n\r<>\0]+$/), date: z.iso.datetime({ offset: true }) });
const tree = z.object({ tree: z.array(z.object({ path: z.string().regex(/^[^/\0]+$/), mode: z.enum(["040000", "100644", "100755", "120000", "160000"]), type: z.enum(["blob", "tree", "commit"]), sha })) });
const commit = z.object({ message: z.string(), tree: sha, parents: z.array(sha), author: identity, committer: identity });
const pull = z.object({ title: z.string(), body: z.string(), head: z.string(), base: z.string() });
const contents = `export function checkoutTotal(cents, taxRate) {\n  return Math.floor(cents * (1 + taxRate));\n}\n`;
const testContents = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { checkoutTotal } from "./src/total.js";\ntest("rounds the checkout total to the nearest cent", () => assert.equal(checkoutTotal(99, 0.05), 104));\n`;

type Write = { path: string; credential: "user" | "installation" | "unknown"; login?: string };
type Pull = { number: number; html_url: string; title: string; body: string; state: "open"; merged_at: null; closed_at: null; created_at: string; head: { ref: string; sha: string }; base: { ref: string }; user: { login: string } };

type Credentials = {
  userLogin?: string;
  installationToken: string;
  installationCanRead(token: string, repository: string): boolean;
  installationExists(token: string): boolean;
  repositorySelected(repository: string): boolean;
};

export async function startAcmeGithubGit(names: readonly string[], parent = tmpdir()) {
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(join(parent, "acme-git-"));
  const repositories = new Map<string, string>();
  const writes: Write[] = [];
  const pulls: Pull[] = [];
  try {
    for (const name of names) {
      const dir = await mkdtemp(join(folder, "bare-"));
      await git(dir, ["init", "--bare", "--initial-branch=main"]);
      const files = name === "acme/storefront" ? {
        "README.md": "# Storefront\n\nRun `npm test`.\n",
        "package.json": '{"name":"storefront","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
        "src/total.js": contents,
        "total.test.js": testContents,
        ".gitignore": "node_modules/\n.env\n",
      } : { "README.md": `# ${name}\n` };
      const index: string[] = [];
      for (const [path, content] of Object.entries(files)) {
        const blob = (await text(dir, ["hash-object", "-w", "--stdin"], content)).trim();
        index.push(`100644 ${blob}\t${path}\0`);
      }
      await git(dir, ["update-index", "-z", "--index-info"], index.join(""));
      const root = (await text(dir, ["write-tree"])).trim();
      const base = (await text(dir, ["-c", "user.name=Maya Chen", "-c", "user.email=101+maya-chen@users.noreply.github.com", "commit-tree", root, "-m", "Initial commit"])).trim();
      await createRef(dir, ref("main"), base);
      repositories.set(name, dir);
    }
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }

  return {
    writes: () => [...writes],
    pulls: () => [...pulls],
    async readBranch(repository: string, branch: string) {
      const dir = repositories.get(repository);
      if (!dir) throw new Error("Unknown Acme repository.");
      const head = await refSha(dir, ref(branch));
      if (!head) return null;
      const raw = await text(dir, ["cat-file", "commit", head]);
      const headers = raw.split("\n\n", 1)[0]?.split("\n") ?? [];
      return { sha: head, author: headers.find(line => line.startsWith("author "))?.slice(7), parent: headers.find(line => line.startsWith("parent "))?.slice(7) };
    },
    async handle(request: IncomingMessage, response: ServerResponse, url: URL, auth: Credentials) {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(body));
        return true;
      };
      const missing = () => json(404, { message: "Not found" });
      const raw = async () => {
        const buffers: Buffer[] = [];
        for await (const chunk of request) {
          if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary Git request.");
          buffers.push(chunk);
        }
        return Buffer.concat(buffers);
      };
      const input = async (): Promise<unknown> => JSON.parse((await raw()).toString());
      const smart = /^\/([^/]+\/[^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (smart?.[1]) {
        const repository = decodeURIComponent(smart[1]);
        const dir = repositories.get(repository);
        const encoded = request.headers.authorization?.match(/^Basic (.+)$/)?.[1];
        const basic = encoded ? Buffer.from(encoded, "base64").toString() : "";
        const token = basic.match(/^x-access-token:(.+)$/)?.[1] ?? "";
        if (smart[2] === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack") {
          writes.push({ path: url.pathname, credential: auth.installationExists(token) ? "installation" : "unknown" });
          return json(403, { message: "Git writes are not supported" });
        }
        if (!dir || !auth.installationCanRead(token, repository)) {
          response.setHeader("WWW-Authenticate", 'Basic realm="GitHub"');
          return json(401, { message: "Authentication required" });
        }
        if (request.method === "GET" && smart[2] === "info/refs" && url.searchParams.get("service") === "git-upload-pack") {
          const refs = await git(dir, ["upload-pack", "--stateless-rpc", "--advertise-refs", "."]);
          response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
          response.end(Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), refs]));
          return true;
        }
        if (request.method === "POST" && smart[2] === "git-upload-pack") {
          const pack = await git(dir, ["upload-pack", "--stateless-rpc", "."], await raw());
          response.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
          response.end(pack);
          return true;
        }
        return missing();
      }
      const match = /^\/repos\/([^/]+\/[^/]+)(\/git\/.+|\/pulls)$/.exec(url.pathname);
      if (!match?.[1] || !match[2]) return false;
      const repository = decodeURIComponent(match[1]);
      const path = match[2];
      const dir = repositories.get(repository);
      if (request.method !== "GET") writes.push({ path: url.pathname, credential: auth.userLogin ? "user" : auth.installationExists(auth.installationToken) ? "installation" : "unknown", login: auth.userLogin });
      if (!dir || !auth.repositorySelected(repository)) return missing();
      if (request.method !== "GET" && (auth.userLogin !== "maya-chen" || repository !== "acme/storefront")) return json(403, { message: "Write access denied" });
      if (request.method === "GET") {
        if (!auth.userLogin && !auth.installationCanRead(auth.installationToken, repository)) return missing();
        if (path.startsWith("/git/commits/")) {
          const hash = sha.safeParse(path.slice(13));
          if (!hash.success) return missing();
          const root = await text(dir, ["rev-parse", "--verify", `${hash.data}^{tree}`]).catch(() => null);
          return root ? json(200, { sha: hash.data, tree: { sha: root.trim() } }) : missing();
        }
        if (path.startsWith("/git/trees/")) {
          const hash = sha.safeParse(path.slice(11));
          if (!hash.success) return missing();
          const output = await text(dir, ["ls-tree", "-z", hash.data]).catch(() => null);
          if (output === null) return missing();
          return json(200, { sha: hash.data, truncated: false, tree: output.split("\0").filter(Boolean).map(line => {
            const entry = /^([0-9]+) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
            if (!entry) throw new Error("Invalid Git tree entry.");
            return { mode: entry[1], type: entry[2], sha: entry[3], path: entry[4] };
          }) });
        }
        if (path.startsWith("/git/ref/heads/")) {
          const name = ref(decodeURIComponent(path.slice(15)));
          const hash = await refSha(dir, name);
          return hash ? json(200, { ref: name, object: { sha: hash } }) : missing();
        }
        if (path === "/pulls" && auth.userLogin) return json(200, pulls.filter(row => url.searchParams.get("head") === `acme:${row.head.ref}`));
        return missing();
      }
      if (request.method !== "POST") return missing();
      if (path === "/git/blobs") {
        const blob = z.object({ content: z.string(), encoding: z.literal("base64") }).parse(await input());
        return json(201, { sha: (await text(dir, ["hash-object", "-w", "--stdin"], Buffer.from(blob.content, "base64"))).trim() });
      }
      if (path === "/git/trees") {
        const rows = tree.parse(await input()).tree;
        const entries = rows.map(row => `${row.mode} ${row.type} ${row.sha}\t${row.path}\0`).join("");
        return json(201, { sha: (await text(dir, ["mktree", "-z"], entries)).trim() });
      }
      if (path === "/git/commits") {
        const data = commit.parse(await input());
        const stamp = (person: z.infer<typeof identity>) => `${person.name} <${person.email}> ${Math.floor(Date.parse(person.date) / 1000)} +0000`;
        const rawCommit = [`tree ${data.tree}`, ...data.parents.map(parent => `parent ${parent}`), `author ${stamp(data.author)}`, `committer ${stamp(data.committer)}`, "", data.message].join("\n");
        return json(201, { sha: (await text(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], rawCommit)).trim() });
      }
      if (path === "/git/refs") {
        const data = z.object({ ref: z.string().startsWith("refs/heads/"), sha }).parse(await input());
        const created = await createRef(dir, data.ref, data.sha).then(() => true, () => false);
        return created ? json(201, { ref: data.ref, object: { sha: data.sha } }) : json(422, { message: "Reference already exists or is invalid" });
      }
      if (path === "/pulls" && auth.userLogin) {
        const args = pull.parse(await input());
        const head = await refSha(dir, ref(args.head));
        if (!head || !await refSha(dir, ref(args.base)) || pulls.some(row => row.head.ref === args.head)) return json(422, { message: "Invalid or duplicate pull request" });
        const number = pulls.length + 1;
        const item: Pull = { number, html_url: `${url.origin}/${repository}/pull/${number}`, title: args.title, body: args.body,
          state: "open", merged_at: null, closed_at: null, created_at: new Date().toISOString(), head: { ref: args.head, sha: head }, base: { ref: args.base }, user: { login: auth.userLogin } };
        pulls.push(item);
        return json(201, item);
      }
      return missing();
    },
    [Symbol.asyncDispose]: () => rm(folder, { recursive: true, force: true }),
  };
}
