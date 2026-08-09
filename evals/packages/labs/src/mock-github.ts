import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockGithubRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface MockGithubRequest {
  method: string;
  path: string;
  url: string;
  at: string;
  authorization: string | null;
}

export interface MockGithubHandle {
  apiUrl: string;
  /** Replaces the repository's complete file map and returns its deterministic new head SHA. */
  advanceHead(fullName: string, files: Record<string, string>): { headSha: string };
  injectFaults(fault: MockGithubFault): void;
  renameRepository(oldFullName: string, newFullName: string): void;
  requests(): Promise<MockGithubRequest[]>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface MockGithubFault {
  count: number;
  status: number;
  pathIncludes?: string;
  retryAfterSeconds?: number;
  delayMs?: number;
}

export interface StartMockGithubOptions {
  installationId: number;
  accountLogin: string;
  repositories: MockGithubRepository[];
  /** files by repo fullName -> { branch, files: Record<repoRelativePath, string> } */
  repoFiles: Record<string, { branch: string; files: Record<string, string> }>;
  port?: number;
}

interface RepositorySnapshot {
  headSha: string;
  treeSha: string;
  tree: Array<{
    path: string;
    type: "blob" | "tree";
    sha: string;
    size?: number;
  }>;
}

interface PendingFault extends MockGithubFault {
  remaining: number;
}

function isAddressInfo(value: ReturnType<Server["address"]>): value is AddressInfo {
  return typeof value === "object"
    && value !== null
    && typeof value.address === "string"
    && typeof value.family === "string"
    && typeof value.port === "number";
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestMethod(request: IncomingMessage): string {
  return (request.method ?? "GET").toUpperCase();
}

function authorizationHeader(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function contentDigest(files: Record<string, string>): string {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function repositorySnapshot(files: Record<string, string>): RepositorySnapshot {
  const digest = contentDigest(files);
  const treeSha = createHash("sha256").update(`tree\0${digest}`).digest("hex");
  const headSha = createHash("sha1").update(`commit\0${treeSha}`).digest("hex");
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    const segments = path.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }

  const tree: RepositorySnapshot["tree"] = [];
  for (const path of [...directories].sort()) {
    tree.push({
      path,
      type: "tree",
      sha: createHash("sha1").update(`directory\0${path}\0${digest}`).digest("hex"),
    });
  }
  for (const [path, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    tree.push({
      path,
      type: "blob",
      sha: createHash("sha1").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    });
  }
  tree.sort((left, right) => left.path.localeCompare(right.path));
  return { headSha, treeSha, tree };
}

function repositoryJson(repository: MockGithubRepository): Record<string, unknown> {
  return {
    id: repository.id,
    full_name: repository.fullName,
    default_branch: repository.defaultBranch,
    private: repository.private,
  };
}

function positiveInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function listen(server: Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (isAddressInfo(address)) {
        resolve(address);
        return;
      }
      reject(new Error("Mock GitHub server did not expose a TCP port."));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections();
  });
}

export async function startMockGithub(options: StartMockGithubOptions): Promise<MockGithubHandle> {
  const requests: MockGithubRequest[] = [];
  const faults: PendingFault[] = [];
  const repositories = options.repositories.map((repository) => ({ ...repository }));
  const repositoriesByFullName = new Map<string, MockGithubRepository>();
  const fixturesByFullName = new Map<string, { branch: string; files: Record<string, string> }>();
  const snapshotsByFullName = new Map<string, RepositorySnapshot>();
  for (const repository of repositories) {
    repositoriesByFullName.set(repository.fullName, repository);
    const fixture = options.repoFiles[repository.fullName];
    if (fixture) {
      const files = { ...fixture.files };
      fixturesByFullName.set(repository.fullName, { branch: fixture.branch, files });
      snapshotsByFullName.set(repository.fullName, repositorySnapshot(files));
    }
  }

  let apiUrl = "http://127.0.0.1";
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", apiUrl);
      const method = requestMethod(request);
      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === "GET" && url.pathname === "/requests") {
        sendJson(response, 200, { requests });
        return;
      }

      requests.push({
        method,
        path: url.pathname,
        url: `${url.pathname}${url.search}`,
        at: new Date().toISOString(),
        authorization: authorizationHeader(request),
      });

      const faultIndex = faults.findIndex((fault) => (
        fault.remaining > 0 && (!fault.pathIncludes || url.pathname.includes(fault.pathIncludes))
      ));
      if (faultIndex >= 0) {
        const fault = faults[faultIndex];
        if (fault) {
          fault.remaining -= 1;
          if (fault.remaining === 0) faults.splice(faultIndex, 1);
          if (fault.delayMs !== undefined) {
            await sleep(fault.delayMs);
          } else {
            const headers: Record<string, string> = {};
            if (fault.retryAfterSeconds !== undefined) {
              headers["retry-after"] = String(fault.retryAfterSeconds);
            }
            sendJson(response, fault.status, { message: "mock fault" }, headers);
            return;
          }
        }
      }

      const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      if (method === "POST"
        && segments.length === 4
        && segments[0] === "app"
        && segments[1] === "installations"
        && segments[2] === String(options.installationId)
        && segments[3] === "access_tokens") {
        sendJson(response, 201, { token: `mock-installation-token-${options.installationId}` });
        return;
      }
      if (method === "GET"
        && segments.length === 3
        && segments[0] === "app"
        && segments[1] === "installations"
        && segments[2] === String(options.installationId)) {
        sendJson(response, 200, {
          id: options.installationId,
          account: { login: options.accountLogin, type: "Organization" },
          repository_selection: "all",
          html_url: `${apiUrl}/settings`,
        });
        return;
      }
      if (method === "GET" && url.pathname === "/installation/repositories") {
        const perPage = positiveInteger(url.searchParams.get("per_page"), 30);
        const page = positiveInteger(url.searchParams.get("page"), 1);
        const start = (page - 1) * perPage;
        sendJson(response, 200, {
          total_count: repositories.length,
          repositories: repositories.slice(start, start + perPage).map(repositoryJson),
        });
        return;
      }
      if (segments[0] === "repos" && segments.length >= 3) {
        const fullName = `${segments[1]}/${segments[2]}`;
        const repository = repositoriesByFullName.get(fullName);
        const fixture = fixturesByFullName.get(fullName);
        const snapshot = snapshotsByFullName.get(fullName);
        if (!repository) {
          sendJson(response, 404, { message: "not found" });
          return;
        }
        if (method === "GET" && segments.length === 3) {
          sendJson(response, 200, repositoryJson(repository));
          return;
        }
        if (method === "GET" && segments.length === 5 && segments[3] === "branches") {
          const branch = segments[4];
          if (branch === repository.defaultBranch && (!fixture || fixture.branch === branch)) {
            sendJson(response, 200, { name: branch });
          } else {
            sendJson(response, 404, { message: "not found" });
          }
          return;
        }
        if (method === "GET" && segments.length === 5 && segments[3] === "commits") {
          if (fixture && snapshot && segments[4] === fixture.branch) {
            sendJson(response, 200, {
              sha: snapshot.headSha,
              commit: { tree: { sha: snapshot.treeSha } },
            });
          } else {
            sendJson(response, 404, { message: "not found" });
          }
          return;
        }
        if (method === "GET"
          && segments.length === 6
          && segments[3] === "git"
          && segments[4] === "trees") {
          if (snapshot && segments[5] === snapshot.treeSha && url.searchParams.get("recursive") === "1") {
            sendJson(response, 200, { truncated: false, tree: snapshot.tree });
          } else {
            sendJson(response, 404, { message: "not found" });
          }
          return;
        }
        if (method === "GET" && segments.length >= 5 && segments[3] === "contents") {
          const path = segments.slice(4).join("/");
          const ref = url.searchParams.get("ref") ?? repository.defaultBranch;
          const content = fixture?.branch === ref ? fixture.files[path] : undefined;
          if (typeof content === "string") {
            sendJson(response, 200, { content: Buffer.from(content).toString("base64"), encoding: "base64" });
          } else {
            sendJson(response, 404, { message: "not found" });
          }
          return;
        }
      }
      sendJson(response, 404, { message: "not found" });
    } catch (error) {
      // Log the detail server-side; never echo error text into the HTTP body
      // (CodeQL js/stack-trace-exposure), even in a local test witness.
      console.error(`[mock-github] request handler failed: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(response, 500, { message: "mock github internal error" });
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  const address = await listen(server, options.port ?? 0);
  apiUrl = `http://127.0.0.1:${address.port}`;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await close(server);
  };

  return {
    apiUrl,
    advanceHead(fullName, files) {
      const repository = repositoriesByFullName.get(fullName);
      if (!repository) throw new Error(`Mock GitHub repository not found: ${fullName}`);
      const fixture = fixturesByFullName.get(fullName);
      const nextFiles = { ...files };
      const snapshot = repositorySnapshot(nextFiles);
      fixturesByFullName.set(fullName, {
        branch: fixture?.branch ?? repository.defaultBranch,
        files: nextFiles,
      });
      snapshotsByFullName.set(fullName, snapshot);
      return { headSha: snapshot.headSha };
    },
    injectFaults(fault) {
      if (fault.count <= 0) return;
      faults.push({ ...fault, remaining: fault.count });
    },
    renameRepository(oldFullName, newFullName) {
      const repository = repositoriesByFullName.get(oldFullName);
      if (!repository) throw new Error(`Mock GitHub repository not found: ${oldFullName}`);
      if (repositoriesByFullName.has(newFullName)) {
        throw new Error(`Mock GitHub repository already exists: ${newFullName}`);
      }
      const renamed = { ...repository, fullName: newFullName };
      const index = repositories.findIndex((candidate) => candidate.fullName === oldFullName);
      if (index >= 0) repositories[index] = renamed;
      repositoriesByFullName.delete(oldFullName);
      repositoriesByFullName.set(newFullName, renamed);

      const fixture = fixturesByFullName.get(oldFullName);
      fixturesByFullName.delete(oldFullName);
      if (fixture) fixturesByFullName.set(newFullName, fixture);
      const snapshot = snapshotsByFullName.get(oldFullName);
      snapshotsByFullName.delete(oldFullName);
      if (snapshot) snapshotsByFullName.set(newFullName, snapshot);
    },
    async requests() {
      return requests.map((request) => ({ ...request }));
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
