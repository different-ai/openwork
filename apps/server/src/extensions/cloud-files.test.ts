import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerConfig } from "../types.js";
import { callOpenWorkCloudFileAction } from "./cloud-files.js";

const roots: string[] = [];

function testConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "test-client-token",
    hostToken: "test-host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 30_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

function cloudMcp() {
  return {
    type: "remote",
    enabled: true,
    url: "https://api.openwork.test/mcp/agent",
    headers: { Authorization: "Bearer member-token" },
    oauth: false,
  };
}

async function tempRoot() {
  const root = join(tmpdir(), `openwork-cloud-files-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("stage_file sends exact workspace bytes and server-derived metadata outside model context", async () => {
  const root = await tempRoot();
  const source = join(root, "agreement.docx");
  const sourceBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xfb, 0xef]);
  await writeFile(source, sourceBytes);
  const staged: { value: { url: string; authorization: string | null; file: File | null } | null } = { value: null };

  const result = await callOpenWorkCloudFileAction(
    testConfig(root),
    "stage_file",
    { path: "agreement.docx", filename: "agent-change.pdf", mimeType: "application/pdf" },
    { directory: root },
    {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async (url, init) => {
        const form = init?.body as FormData;
        staged.value = {
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          file: form.get("file") as File,
        };
        return new Response(JSON.stringify({
          fileRef: "file_ref_0123456789abcdef0123456789abcdef",
          filename: "agreement.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          byteLength: sourceBytes.byteLength,
          sha256: "digest",
          expiresAt: "2026-07-31T00:00:00.000Z",
        }), { headers: { "content-type": "application/json" } });
      },
    },
  );

  expect(result?.ok).toBe(true);
  expect(staged.value?.url).toBe("https://api.openwork.test/v1/file-references");
  expect(staged.value?.authorization).toBe("Bearer member-token");
  expect(staged.value?.file?.name).toBe("agreement.docx");
  expect(staged.value?.file?.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  expect(Buffer.from(await staged.value!.file!.arrayBuffer())).toEqual(sourceBytes);
});

test("materialize_file writes exact cloud bytes into the active workspace inbox", async () => {
  const root = await tempRoot();
  const bytes = Buffer.from("downloaded bytes", "utf8");
  const result = await callOpenWorkCloudFileAction(
    testConfig(root),
    "materialize_file",
    { fileRef: "file_ref_0123456789abcdef0123456789abcdef" },
    { directory: root },
    {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async () => new Response(bytes, {
        headers: {
          "content-type": "application/pdf",
          "x-openwork-filename": encodeURIComponent("invoice.pdf"),
          "x-openwork-sha256": "digest",
        },
      }),
    },
  );

  expect(result?.ok).toBe(true);
  if (!result || !("workspacePath" in result)) throw new Error("Expected materialized file result");
  expect(result?.workspacePath).toBe(join(
    ".opencode",
    "openwork",
    "inbox",
    "cloud-downloads",
    "file_ref_0123456789abcdef0123456789abcdef-invoice.pdf",
  ));
  expect(Buffer.from(await readFile(result.absolutePath))).toEqual(bytes);
});
