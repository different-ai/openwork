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

export interface MockWardenGithubComment {
  id: number;
  body: string;
  user: { login: string; type: "Bot" | "User" };
}

export interface MockWardenGithubThread {
  id: string;
  isResolved: boolean;
  body: string;
  author: { login: string; type: "Bot" | "User" };
}

export interface MockWardenGithubRun {
  id: string;
  runNumber: number;
  attempt: number;
  headSha: string;
  headBranch?: string;
  repository?: string;
  status?: string;
  conclusion?: string;
  workflowPath?: string;
  pullRequest?: number;
}

export interface MockWardenGithubRequest {
  method: string;
  path: string;
  url: string;
  authorization: string | null;
  body: string;
}

export interface StartMockWardenGithubOptions {
  token: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  baseSha: string;
  headBranch: string;
  baseBranch: string;
  comments?: MockWardenGithubComment[];
  threads?: MockWardenGithubThread[];
  port?: number;
}

export interface MockWardenGithubHandle {
  apiUrl: string;
  graphqlUrl: string;
  seedRun(run: MockWardenGithubRun): void;
  seedComments(comments: MockWardenGithubComment[]): void;
  seedThreads(threads: MockWardenGithubThread[]): void;
  setPullHead(headSha: string): void;
  changeHeadAfterGraphql(headSha: string): void;
  setGraphqlErrors(enabled: boolean): void;
  comments(): MockWardenGithubComment[];
  requests(): MockWardenGithubRequest[];
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
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

function requestBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * A repository-scoped GitHub HTTP witness for the production Warden reporter.
 * It intentionally implements only pull/run reads, issue-comment writes, and
 * the read-only reviewThreads query. Review decisions and thread mutations
 * have no successful route.
 */
export async function startMockWardenGithub(
  options: StartMockWardenGithubOptions,
): Promise<MockWardenGithubHandle> {
  const [owner, name, extra] = options.repository.split("/");
  if (!owner || !name || extra) throw new Error("Mock Warden repository must be owner/name.");

  const recorded: MockWardenGithubRequest[] = [];
  const runs = new Map<string, MockWardenGithubRun>();
  let comments = (options.comments ?? []).map((comment) => ({
    ...comment,
    user: { ...comment.user },
  }));
  let threads = (options.threads ?? []).map((thread) => ({
    ...thread,
    author: { ...thread.author },
  }));
  let nextCommentId = Math.max(0, ...comments.map((comment) => comment.id)) + 1;
  let pullHeadSha = options.headSha;
  let headAfterGraphql: string | null = null;
  let graphqlErrors = false;
  let apiUrl = "http://127.0.0.1";
  const repositoryId = 9001;
  const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", apiUrl);
      const method = requestMethod(request);
      const body = await requestBody(request);
      recorded.push({
        method,
        path: url.pathname,
        url: `${url.pathname}${url.search}`,
        authorization: authorizationHeader(request),
        body,
      });

      if (authorizationHeader(request) !== `Bearer ${options.token}`) {
        sendJson(response, 401, { message: "bad credentials" });
        return;
      }

      if (method === "POST" && url.pathname === "/graphql") {
        const payload: unknown = JSON.parse(body);
        if (!isObject(payload) || typeof payload.query !== "string" || !isObject(payload.variables)) {
          sendJson(response, 400, { message: "invalid GraphQL request" });
          return;
        }
        if (/\bmutation\b/.test(payload.query)) {
          sendJson(response, 405, { message: "review mutations are not implemented" });
          return;
        }
        if (
          payload.variables.owner !== owner || payload.variables.name !== name ||
          payload.variables.pr !== options.pullRequest
        ) {
          sendJson(response, 404, { message: "not found" });
          return;
        }
        if (graphqlErrors) {
          sendJson(response, 200, { errors: [{ message: "fixture GraphQL failure" }] });
          return;
        }
        const after = payload.variables.after;
        if (after !== null && typeof after !== "string") {
          sendJson(response, 400, { message: "invalid GraphQL cursor" });
          return;
        }
        let start = 0;
        if (typeof after === "string") {
          const match = /^warden-thread-cursor-(\d+)$/.exec(after);
          if (!match?.[1]) {
            sendJson(response, 400, { message: "invalid GraphQL cursor" });
            return;
          }
          start = Number(match[1]);
        }
        const pageSize = 100;
        const page = threads.slice(start, start + pageSize);
        const nextStart = start + page.length;
        const hasNextPage = nextStart < threads.length;
        sendJson(response, 200, {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: {
                    hasNextPage,
                    endCursor: hasNextPage ? `warden-thread-cursor-${nextStart}` : null,
                  },
                  nodes: page.map((thread) => ({
                    id: thread.id,
                    isResolved: thread.isResolved,
                    comments: {
                      nodes: [{
                        body: thread.body,
                        author: {
                          login: thread.author.login,
                          __typename: thread.author.type,
                        },
                      }],
                    },
                  })),
                },
              },
            },
          },
        });
        if (headAfterGraphql !== null) {
          pullHeadSha = headAfterGraphql;
          headAfterGraphql = null;
        }
        return;
      }

      if (!url.pathname.startsWith(`${root}/`)) {
        sendJson(response, 404, { message: "not found" });
        return;
      }

      if (method === "GET" && url.pathname === `${root}/pulls/${options.pullRequest}`) {
        sendJson(response, 200, {
          number: options.pullRequest,
          state: "open",
          merged: false,
          merged_at: null,
          head: {
            sha: pullHeadSha,
            ref: options.headBranch,
            repo: { id: repositoryId, full_name: options.repository },
          },
          base: {
            sha: options.baseSha,
            ref: options.baseBranch,
            repo: { id: repositoryId, full_name: options.repository },
          },
        });
        return;
      }

      const runPrefix = `${root}/actions/runs/`;
      if (method === "GET" && url.pathname.startsWith(runPrefix)) {
        const runId = decodeURIComponent(url.pathname.slice(runPrefix.length));
        const run = runs.get(runId);
        if (!run) {
          sendJson(response, 404, { message: "not found" });
          return;
        }
        const runRepository = run.repository ?? options.repository;
        sendJson(response, 200, {
          id: Number(run.id),
          run_number: run.runNumber,
          run_attempt: run.attempt,
          event: "pull_request",
          head_sha: run.headSha,
          head_branch: run.headBranch ?? options.headBranch,
          head_repository: { full_name: runRepository },
          repository: { full_name: options.repository },
          status: run.status ?? "completed",
          conclusion: run.conclusion ?? "success",
          path: run.workflowPath ?? ".github/workflows/warden.yml",
          pull_requests: [{
            number: run.pullRequest ?? options.pullRequest,
            url: `https://api.github.com/repos/${owner}/${name}/pulls/${run.pullRequest ?? options.pullRequest}`,
            head: { sha: run.headSha, repo: { id: repositoryId, full_name: runRepository } },
            base: { sha: options.baseSha, repo: { full_name: options.repository } },
          }],
        });
        return;
      }

      if (method === "GET" && url.pathname === `${root}/issues/${options.pullRequest}/comments`) {
        const perPage = positiveInteger(url.searchParams.get("per_page"), 30);
        const page = positiveInteger(url.searchParams.get("page"), 1);
        const start = (page - 1) * perPage;
        sendJson(response, 200, comments.slice(start, start + perPage));
        return;
      }

      if (method === "POST" && url.pathname === `${root}/issues/${options.pullRequest}/comments`) {
        const payload: unknown = JSON.parse(body);
        if (!isObject(payload) || typeof payload.body !== "string") {
          sendJson(response, 422, { message: "body is required" });
          return;
        }
        const comment: MockWardenGithubComment = {
          id: nextCommentId,
          body: payload.body,
          user: { login: "github-actions[bot]", type: "Bot" },
        };
        nextCommentId += 1;
        comments.push(comment);
        sendJson(response, 201, comment);
        return;
      }

      const commentPrefix = `${root}/issues/comments/`;
      if (method === "PATCH" && url.pathname.startsWith(commentPrefix)) {
        const id = Number(decodeURIComponent(url.pathname.slice(commentPrefix.length)));
        const index = comments.findIndex((comment) => comment.id === id);
        const payload: unknown = JSON.parse(body);
        if (index < 0) {
          sendJson(response, 404, { message: "not found" });
          return;
        }
        if (!isObject(payload) || typeof payload.body !== "string") {
          sendJson(response, 422, { message: "body is required" });
          return;
        }
        const previous = comments[index];
        if (!previous) throw new Error("Mock Warden comment disappeared during update.");
        const updated = { ...previous, body: payload.body, user: { ...previous.user } };
        comments[index] = updated;
        sendJson(response, 200, updated);
        return;
      }

      sendJson(response, 404, { message: "not found" });
    } catch (error) {
      console.error(`[mock-warden-github] request handler failed: ${error instanceof Error ? error.message : String(error)}`);
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
    graphqlUrl: `${apiUrl}/graphql`,
    seedRun(run) {
      runs.set(run.id, { ...run });
    },
    seedComments(nextComments) {
      comments = nextComments.map((comment) => ({ ...comment, user: { ...comment.user } }));
      nextCommentId = Math.max(0, ...comments.map((comment) => comment.id)) + 1;
    },
    seedThreads(nextThreads) {
      threads = nextThreads.map((thread) => ({ ...thread, author: { ...thread.author } }));
    },
    setPullHead(headSha) {
      pullHeadSha = headSha;
    },
    changeHeadAfterGraphql(headSha) {
      headAfterGraphql = headSha;
    },
    setGraphqlErrors(enabled) {
      graphqlErrors = enabled;
    },
    comments() {
      return comments.map((comment) => ({ ...comment, user: { ...comment.user } }));
    },
    requests() {
      return recorded.map((request) => ({ ...request }));
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
