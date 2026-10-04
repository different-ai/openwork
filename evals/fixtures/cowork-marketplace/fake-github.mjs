// A stand-in for github.com serving one public plugin marketplace repository,
// shaped like the Claude Cowork marketplaces people migrate from. Den's public
// GitHub import reaches it through DEN_PUBLIC_GITHUB_API_BASE (<origin>/api)
// and DEN_PUBLIC_GITHUB_RAW_BASE (<origin>/raw). Every request is recorded and
// served at GET /__requests so a spec can count what one import cost.
//
// Plain Node, no dependencies: worlds run it on the host or inside a Daytona
// sandbox with `node fake-github.mjs <port>`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const { repo, files } = JSON.parse(readFileSync(new URL("./repo.json", import.meta.url), "utf8"));
const port = Number(process.argv[2] ?? 0);
const sha = (text) => createHash("sha1").update(text).digest("hex");
const HEAD = sha(`commit:${JSON.stringify(files)}`);
const TREE = sha(`tree:${JSON.stringify(files)}`);

const directories = new Set();
for (const path of Object.keys(files)) {
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
}
const tree = [
  ...[...directories].map((path) => ({ path, type: "tree", sha: sha(`dir:${path}`) })),
  ...Object.entries(files).map(([path, content]) => ({ path, type: "blob", sha: sha(content), size: Buffer.byteLength(content) })),
].sort((a, b) => a.path.localeCompare(b.path));

const requests = [];
const send = (response, status, body, type = "application/json") => {
  response.writeHead(status, { "content-type": type });
  response.end(type === "application/json" ? JSON.stringify(body) : body);
};

const repoPath = `/api/repos/${repo.owner}/${repo.repo}`;
const rawPrefix = `/raw/${repo.owner}/${repo.repo}/`;

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/__requests") return send(response, 200, { requests, head: HEAD });
  // An upstream edit: GET /__set?path=<file>&b64=<base64 content>.
  if (url.pathname === "/__set") {
    const path = url.searchParams.get("path") ?? "";
    if (!(path in files)) return send(response, 404, { message: "unknown file" });
    files[path] = Buffer.from(url.searchParams.get("b64") ?? "", "base64").toString("utf8");
    return send(response, 200, { ok: true });
  }
  requests.push({ kind: url.pathname.startsWith("/api/") ? "api" : url.pathname.startsWith("/raw/") ? "raw" : "other", path: url.pathname });

  if (url.pathname === repoPath) return send(response, 200, { full_name: `${repo.owner}/${repo.repo}`, default_branch: repo.ref, private: false });
  if (url.pathname === `${repoPath}/commits/${repo.ref}` || url.pathname === `${repoPath}/commits/${HEAD}`) {
    return send(response, 200, { sha: HEAD, commit: { tree: { sha: TREE } } });
  }
  if (url.pathname === `${repoPath}/git/trees/${TREE}`) return send(response, 200, { sha: TREE, tree, truncated: false });
  if (url.pathname.startsWith(`${repoPath}/contents/`)) {
    const path = decodeURIComponent(url.pathname.slice(`${repoPath}/contents/`.length));
    const content = files[path];
    if (content === undefined) return send(response, 404, { message: "Not Found" });
    return send(response, 200, { path, encoding: "base64", content: Buffer.from(content).toString("base64") });
  }
  if (url.pathname.startsWith(rawPrefix)) {
    const rest = decodeURIComponent(url.pathname.slice(rawPrefix.length));
    for (const ref of [HEAD, repo.ref]) {
      if (!rest.startsWith(`${ref}/`)) continue;
      const content = files[rest.slice(ref.length + 1)];
      if (content !== undefined) return send(response, 200, content, "text/plain; charset=utf-8");
    }
    return send(response, 404, "404: Not Found", "text/plain");
  }
  return send(response, 404, { message: "Not Found" });
}).listen(port, "127.0.0.1", function () {
  console.log(`fake-github listening on http://127.0.0.1:${this.address().port}`);
});
