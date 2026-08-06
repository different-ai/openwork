import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-artifacts-"));
  roots.push(root);
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(join(root, "reports", "artifact-eval.md"), "# Artifact Eval\n\nHello markdown.\n", "utf8");
  await writeFile(join(root, "reports", "artifact-eval.csv"), "name,revenue\nAda,10\nGrace,20\n", "utf8");
  await writeFile(join(root, "reports", "index.html"), "<!doctype html><h1>Artifact site</h1>", "utf8");
  await writeFile(join(root, "reports", "artifact-eval.xlsx"), new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]));
  await writeFile(join(root, "reports", "artifact-eval.pptx"), new Uint8Array([80, 75, 3, 4, 5, 6, 7, 8]));
  await writeFile(join(root, "reports", "artifact-eval.docx"), new Uint8Array([80, 75, 3, 4, 9, 10, 11, 12]));
  return root;
}

async function startOpenworkServer(workspaceRoot: string) {
  const previousDataDir = process.env.OPENWORK_DATA_DIR;
  process.env.OPENWORK_DATA_DIR = join(workspaceRoot, ".openwork-test-data");
  stops.push(() => {
    if (previousDataDir === undefined) delete process.env.OPENWORK_DATA_DIR;
    else process.env.OPENWORK_DATA_DIR = previousDataDir;
  });
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const transport: { fetch?: (request: Request) => Response | Promise<Response> } = {};
  const server = await startServer(config, {
    serve: async (options) => {
      transport.fetch = options.fetch;
      return { port: 0, stop: () => {} };
    },
  }) as Served;
  stops.push(() => server.stop(true));
  const dispatch = transport.fetch;
  if (!dispatch) throw new Error("Expected the in-process server handler");
  return {
    request: (path: string, init?: RequestInit) => dispatch(new Request(`http://openwork.test${path}`, init)),
    token: config.token,
  };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("artifact file routes", () => {
  test("resolve, read, write, and download markdown/csv/xlsx/pptx/docx/html artifacts", async () => {
    const root = await createWorkspaceRoot();
    const { request, token } = await startOpenworkServer(root);

    const resolveResponse = await request("/workspace/ws_1/artifacts/resolve", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        targets: [
          { kind: "file", value: join(root, "reports", "artifact-eval.md"), confidence: 95 },
          { kind: "file", value: "Workspace/32423/reports/artifact-eval.md", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.csv", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.xlsx", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.pptx", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.docx", confidence: 80 },
          { kind: "file", value: "reports/index.html", confidence: 80 },
          { kind: "file", value: "reports/missing.md", confidence: 80 },
          { kind: "url", value: "http://localhost:4321", confidence: 80 },
          { kind: "url", value: "ws://localhost:4321/socket", confidence: 80 },
        ],
      }),
    });
    expect(resolveResponse.status).toBe(200);
    const resolved = await resolveResponse.json() as { items: Array<any> };
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.md")).toMatchObject({ exists: true, preview: "markdown", confidence: 95 });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.csv")).toMatchObject({ exists: true, preview: "sheet" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.xlsx")).toMatchObject({ exists: true, preview: "sheet" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.pptx")).toMatchObject({ exists: true, preview: "slides", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.docx")).toMatchObject({ exists: true, preview: "document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(resolved.items.find((item) => item.value === "reports/index.html")).toMatchObject({ exists: true, preview: "html" });
    expect(resolved.items.find((item) => item.value === "reports/missing.md")).toMatchObject({ exists: false });
    expect(resolved.items.find((item) => item.value === "http://localhost:4321/")).toMatchObject({ kind: "url", preview: "browser" });
    expect(resolved.items.find((item) => item.value === "ws://localhost:4321/socket")).toMatchObject({ kind: "url", preview: "browser" });

    const csvRead = await request(`/workspace/ws_1/files/content?path=${encodeURIComponent("reports/artifact-eval.csv")}`, { headers: auth(token) });
    expect(await csvRead.json()).toMatchObject({ content: "name,revenue\nAda,10\nGrace,20\n" });

    const mdWrite = await request("/workspace/ws_1/files/content", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "reports/artifact-eval.md", content: "# Updated\n" }),
    });
    expect(mdWrite.status).toBe(200);
    expect(await readFile(join(root, "reports", "artifact-eval.md"), "utf8")).toBe("# Updated\n");

    const xlsxWrite = await request("/workspace/ws_1/files/raw", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "reports/artifact-eval.xlsx", dataBase64: Buffer.from([80, 75, 9, 9]).toString("base64") }),
    });
    expect(xlsxWrite.status).toBe(200);

    const xlsxDownload = await request(`/workspace/ws_1/files/raw?path=${encodeURIComponent("reports/artifact-eval.xlsx")}`, { headers: auth(token) });
    expect(xlsxDownload.status).toBe(200);
    expect(Array.from(new Uint8Array(await xlsxDownload.arrayBuffer()))).toEqual([80, 75, 9, 9]);
  });

  test("rejects stale text and binary writes without replacing external changes", async () => {
    const root = await createWorkspaceRoot();
    const { request, token } = await startOpenworkServer(root);
    const markdownPath = join(root, "reports", "artifact-eval.md");
    const binaryPath = join(root, "reports", "artifact-eval.xlsx");

    const markdownBase = (await stat(markdownPath)).mtimeMs;
    await writeFile(markdownPath, "# External markdown\n", "utf8");
    await utimes(markdownPath, new Date(), new Date(markdownBase + 2_000));
    const markdownCurrent = (await stat(markdownPath)).mtimeMs;

    const staleMarkdownWrite = await request("/workspace/ws_1/files/content", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "reports/artifact-eval.md", content: "# Stale local markdown\n", baseUpdatedAt: markdownBase }),
    });
    expect(staleMarkdownWrite.status).toBe(409);
    expect(await staleMarkdownWrite.json()).toMatchObject({
      code: "conflict",
      details: { baseUpdatedAt: markdownBase, currentUpdatedAt: markdownCurrent },
    });
    expect(await readFile(markdownPath, "utf8")).toBe("# External markdown\n");

    const binaryBase = (await stat(binaryPath)).mtimeMs;
    await writeFile(binaryPath, new Uint8Array([80, 75, 7, 7]));
    await utimes(binaryPath, new Date(), new Date(binaryBase + 2_000));
    const binaryCurrent = (await stat(binaryPath)).mtimeMs;
    const staleBinaryWrite = await request("/workspace/ws_1/files/raw", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        path: "reports/artifact-eval.xlsx",
        dataBase64: Buffer.from([80, 75, 8, 8]).toString("base64"),
        baseUpdatedAt: binaryBase,
      }),
    });
    expect(staleBinaryWrite.status).toBe(409);
    expect(await staleBinaryWrite.json()).toMatchObject({
      code: "conflict",
      details: { baseUpdatedAt: binaryBase, currentUpdatedAt: binaryCurrent },
    });
    expect(Array.from(await readFile(binaryPath))).toEqual([80, 75, 7, 7]);
  });
});
