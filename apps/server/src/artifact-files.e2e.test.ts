import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await writeFile(join(root, "reports", "architecture.mmd"), "flowchart LR\n  A --> B\n", "utf8");
  await writeFile(join(root, "reports", "artifact-eval.csv"), "name,revenue\nAda,10\nGrace,20\n", "utf8");
  await writeFile(join(root, "reports", "index.html"), "<!doctype html><h1>Artifact site</h1>", "utf8");
  await writeFile(join(root, "reports", "artifact-eval.ts"), "export const artifact = true;\n", "utf8");
  await mkdir(join(root, "node_modules", "hidden-package"), { recursive: true });
  await writeFile(join(root, "node_modules", "hidden-package", "index.ts"), "export {};\n", "utf8");
  await writeFile(join(root, "reports", "artifact-eval.xlsx"), new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]));
  await writeFile(join(root, "reports", "artifact-eval.pptx"), new Uint8Array([80, 75, 3, 4, 5, 6, 7, 8]));
  await writeFile(join(root, "reports", "artifact-eval.docx"), new Uint8Array([80, 75, 3, 4, 9, 10, 11, 12]));
  return root;
}

async function startOpenworkServer(workspaceRoot: string) {
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
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Connection: "close" };
}

describe("artifact file routes", () => {
  test("resolve, read, write, and download markdown/csv/xlsx/pptx/docx/html artifacts", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);

    const resolveResponse = await fetch(`${base}/workspace/ws_1/artifacts/resolve`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        targets: [
          { kind: "file", value: join(root, "reports", "artifact-eval.md"), confidence: 95 },
          { kind: "file", value: "Workspace/32423/reports/artifact-eval.md", confidence: 80 },
          { kind: "file", value: "reports/architecture.mmd", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.csv", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.xlsx", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.pptx", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.docx", confidence: 80 },
          { kind: "file", value: "reports/index.html", confidence: 80 },
          { kind: "file", value: "reports/artifact-eval.ts", confidence: 80 },
          { kind: "file", value: "reports/missing.md", confidence: 80 },
          { kind: "url", value: "http://localhost:4321", confidence: 80 },
          { kind: "url", value: "ws://localhost:4321/socket", confidence: 80 },
        ],
      }),
    });
    expect(resolveResponse.status).toBe(200);
    const resolved = await resolveResponse.json() as { items: Array<any> };
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.md")).toMatchObject({ exists: true, preview: "markdown", confidence: 95 });
    expect(resolved.items.find((item) => item.value === "reports/architecture.mmd")).toMatchObject({ exists: true, preview: "markdown", contentType: "text/plain; charset=utf-8" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.csv")).toMatchObject({ exists: true, preview: "sheet" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.xlsx")).toMatchObject({ exists: true, preview: "sheet" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.pptx")).toMatchObject({ exists: true, preview: "slides", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.docx")).toMatchObject({ exists: true, preview: "document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(resolved.items.find((item) => item.value === "reports/index.html")).toMatchObject({ exists: true, preview: "html" });
    expect(resolved.items.find((item) => item.value === "reports/artifact-eval.ts")).toMatchObject({ exists: true, preview: "code" });
    expect(resolved.items.find((item) => item.value === "reports/missing.md")).toMatchObject({ exists: false });
    expect(resolved.items.find((item) => item.value === "http://localhost:4321/")).toMatchObject({ kind: "url", preview: "browser" });
    expect(resolved.items.find((item) => item.value === "ws://localhost:4321/socket")).toMatchObject({ kind: "url", preview: "browser" });

    const csvRead = await fetch(`${base}/workspace/ws_1/files/content?path=${encodeURIComponent("reports/artifact-eval.csv")}`, { headers: auth(token) });
    expect(await csvRead.json()).toMatchObject({ content: "name,revenue\nAda,10\nGrace,20\n" });

    const mermaidRead = await fetch(`${base}/workspace/ws_1/files/content?path=${encodeURIComponent("reports/architecture.mmd")}`, { headers: auth(token) });
    expect(await mermaidRead.json()).toMatchObject({ content: "flowchart LR\n  A --> B\n" });

    const mdWrite = await fetch(`${base}/workspace/ws_1/files/content`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "reports/artifact-eval.md", content: "# Updated\n" }),
    });
    expect(mdWrite.status).toBe(200);
    expect(await readFile(join(root, "reports", "artifact-eval.md"), "utf8")).toBe("# Updated\n");

    const xlsxWrite = await fetch(`${base}/workspace/ws_1/files/raw`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path: "reports/artifact-eval.xlsx", dataBase64: Buffer.from([80, 75, 9, 9]).toString("base64") }),
    });
    expect(xlsxWrite.status).toBe(200);

    const xlsxDownload = await fetch(`${base}/workspace/ws_1/files/raw?path=${encodeURIComponent("reports/artifact-eval.xlsx")}`, { headers: auth(token) });
    expect(xlsxDownload.status).toBe(200);
    expect(Array.from(new Uint8Array(await xlsxDownload.arrayBuffer()))).toEqual([80, 75, 9, 9]);
  });

  test("lists code artifacts while excluding heavy directories", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);
    const sessionResponse = await fetch(`${base}/workspace/ws_1/files/sessions`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ write: false }),
    });
    const session = await sessionResponse.json() as { session: { id: string } };
    const catalogResponse = await fetch(`${base}/files/sessions/${session.session.id}/catalog/snapshot?excludeHeavyDirectories=true`, { headers: auth(token) });
    const catalog = await catalogResponse.json() as { items: Array<{ path: string }> };
    expect(catalog.items.map((item) => item.path)).toContain("reports/artifact-eval.ts");
    expect(catalog.items.some((item) => item.path.startsWith("node_modules/"))).toBe(false);
  });
});
