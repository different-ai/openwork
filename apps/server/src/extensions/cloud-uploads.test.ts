import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerConfig } from "../types.js";
import { callOpenWorkCloudUploadAction } from "./cloud-uploads.js";

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
  const root = join(tmpdir(), `openwork-cloud-uploads-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("drive upload sends exact workspace bytes and server-derived Office metadata", async () => {
  const root = await tempRoot();
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xfb, 0xef]);
  await writeFile(join(root, "agreement.docx"), bytes);
  const captured: { file?: File } = {};
  let capturedUrl = "";

  const result = await callOpenWorkCloudUploadAction(
    testConfig(root),
    "drive_upload_file",
    { path: "agreement.docx", filename: "changed.pdf", mimeType: "application/pdf" },
    { directory: root },
    {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        if (!(init?.body instanceof FormData)) throw new Error("Expected multipart form");
        const file = init.body.get("file");
        if (!(file instanceof File)) throw new Error("Expected file");
        captured.file = file;
        return new Response(JSON.stringify({ ok: true, file: { id: "file_1" } }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  expect(result).toEqual({ ok: true, file: { id: "file_1" } });
  expect(capturedUrl).toBe("https://api.openwork.test/v1/direct-uploads/google-workspace/drive-files");
  expect(captured.file?.name).toBe("agreement.docx");
  expect(captured.file?.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  if (!captured.file) throw new Error("Expected captured file");
  expect(Buffer.from(await captured.file.arrayBuffer())).toEqual(bytes);
});

test("Gmail attachment action reuses the same direct multipart transport for multiple paths", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "notes.txt"), "notes");
  await writeFile(join(root, "table.csv"), "a,b\n1,2\n");
  let capturedFiles: File[] = [];
  let capturedPayload = "";

  const result = await callOpenWorkCloudUploadAction(
    testConfig(root),
    "gmail_create_draft_with_attachments",
    {
      to: "sam@example.com",
      subject: "Files",
      body: "Please review.",
      paths: ["notes.txt", "table.csv"],
    },
    { directory: root },
    {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async (_url, init) => {
        if (!(init?.body instanceof FormData)) throw new Error("Expected multipart form");
        capturedFiles = init.body.getAll("file").filter((value): value is File => value instanceof File);
        const payload = init.body.get("payload");
        capturedPayload = typeof payload === "string" ? payload : "";
        return new Response(JSON.stringify({ ok: true, draftId: "draft_1" }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  expect(result).toEqual({ ok: true, draftId: "draft_1" });
  expect(capturedFiles.map((file) => [file.name, file.type])).toEqual([
    ["notes.txt", "text/plain;charset=utf-8"],
    ["table.csv", "text/csv"],
  ]);
  expect(JSON.parse(capturedPayload)).toEqual({
    to: "sam@example.com",
    subject: "Files",
    body: "Please review.",
  });
});

test("direct upload rejects files above the deployed 4 MiB transport ceiling before network I/O", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "too-large.bin"), Buffer.alloc((4 * 1024 * 1024) + 1));
  let fetchCalled = false;

  await expect(callOpenWorkCloudUploadAction(
    testConfig(root),
    "drive_upload_file",
    { path: "too-large.bin" },
    { directory: root },
    {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response();
      },
    },
  )).rejects.toMatchObject({ status: 413, code: "file_too_large" });
  expect(fetchCalled).toBe(false);
});

test("direct upload rejects symlinks that resolve outside authorized roots", async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  await writeFile(join(outside, "secret.txt"), "private");
  await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
  let fetchCalled = false;

  await expect(callOpenWorkCloudUploadAction(
    testConfig(root),
    "drive_upload_file",
    { path: "linked.txt" },
    { directory: root },
    {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response();
      },
    },
  )).rejects.toMatchObject({ status: 404, code: "file_not_found" });
  expect(fetchCalled).toBe(false);
});
