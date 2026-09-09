import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerConfig } from "../types.js";
import { ApiError, formatError } from "../errors.js";
import { OpenWorkExtensionsPreview } from "../opencode-plugins/openwork-extensions-preview.js";
import { OPENWORK_CLOUD_UPLOAD_ACTIONS, callOpenWorkCloudUploadAction } from "./cloud-uploads.js";

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

function payloadFieldNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(payloadFieldNames);
  if (typeof value !== "object" || value === null) return [];
  return [
    ...Object.keys(value),
    ...Object.values(value).flatMap(payloadFieldNames),
  ];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("cloud upload action schemas expose paths and metadata, never inline bytes", () => {
  const fields = OPENWORK_CLOUD_UPLOAD_ACTIONS.flatMap((action) => Object.keys(action.inputSchema.properties));

  expect(fields.sort()).toEqual([
    "bcc",
    "body",
    "cc",
    "connectionId",
    "folderId",
    "path",
    "paths",
    "subject",
    "threadId",
    "to",
  ]);
  expect(fields.filter((field) => /base64|bytes|content|raw/i.test(field))).toEqual([]);
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
  expect(payloadFieldNames(result).filter((field) => /base64|bytes|content|raw/i.test(field))).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
  expect(capturedUrl).toBe("https://api.openwork.test/v1/direct-uploads/google-workspace/drive-files");
  expect(captured.file?.name).toBe("agreement.docx");
  expect(captured.file?.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  if (!captured.file) throw new Error("Expected captured file");
  expect(Buffer.from(await captured.file.arrayBuffer())).toEqual(bytes);
});

test.each([undefined, "google-workspace", "emc_selected"])("Gmail attachment multipart transport preserves connection %s", async (connectionId) => {
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
      ...(connectionId ? { connectionId } : {}),
    },
    { directory: root },
    {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async (_url, init) => {
        expect(init?.headers).toEqual({ authorization: "Bearer member-token" });
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
  expect(payloadFieldNames(result).filter((field) => /base64|bytes|content|raw/i.test(field))).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(Buffer.from("notes").toString("base64"));
  expect(capturedFiles.map((file) => [file.name, file.type])).toEqual([
    ["notes.txt", "text/plain;charset=utf-8"],
    ["table.csv", "text/csv"],
  ]);
  expect(JSON.parse(capturedPayload)).toEqual({
    to: "sam@example.com",
    subject: "Files",
    body: "Please review.",
    ...(connectionId ? { connectionId } : {}),
  });
});

test("Gmail upload rejects invalid connection namespaces before file or network I/O", async () => {
  let calls = 0;
  const root = await tempRoot();
  await expect(callOpenWorkCloudUploadAction(testConfig(root), "gmail_create_draft_with_attachments", {
    paths: ["missing.txt"], connectionId: "external:other",
  }, { directory: root }, {
    readCloudMcp: async () => { calls++; return cloudMcp(); },
    fetchImpl: async () => { calls++; return Response.json({ ok: true }); },
  })).rejects.toMatchObject({ code: "invalid_payload" });
  expect(calls).toBe(0);
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

test("direct upload rejects aggregate attachment bytes above 4 MiB with no network calls", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "part-a.bin"), Buffer.alloc((2 * 1024 * 1024) + 1));
  await writeFile(join(root, "part-b.bin"), Buffer.alloc(2 * 1024 * 1024));
  let networkCalls = 0;

  await expect(callOpenWorkCloudUploadAction(
    testConfig(root),
    "gmail_create_draft_with_attachments",
    {
      to: "sam@example.com",
      subject: "Too large",
      body: "This must fail locally.",
      paths: ["part-a.bin", "part-b.bin"],
    },
    { directory: root },
    {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async () => {
        networkCalls += 1;
        return new Response();
      },
    },
  )).rejects.toMatchObject({ status: 413, code: "files_too_large" });
  expect(networkCalls).toBe(0);
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

test.each(["before-files", "during-credentials"])("Gmail cancellation %s prevents remote multipart dispatch", async (when) => {
  const root = await tempRoot();
  await writeFile(join(root, "notes.txt"), "notes");
  const controller = new AbortController();
  let remoteCalls = 0;
  if (when === "before-files") controller.abort();
  await expect(callOpenWorkCloudUploadAction(testConfig(root), "gmail_create_draft_with_attachments", {
    to: "recipient@example.com", subject: "Review", body: "Please review.", paths: ["notes.txt"],
  }, { directory: root }, {
    signal: controller.signal,
    readCloudMcp: async () => { controller.abort(); return cloudMcp(); },
    fetchImpl: async () => { remoteCalls++; return Response.json({ ok: true, draftId: "draft_1" }); },
  })).rejects.toMatchObject({ status: 499, code: "gmail_attachment_cancelled" });
  expect(remoteCalls).toBe(0);
});

test("Gmail cancellation reaches an already dispatched multipart request without retry", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "notes.txt"), "notes");
  const controller = new AbortController();
  let remoteCalls = 0;
  await expect(callOpenWorkCloudUploadAction(testConfig(root), "gmail_create_draft_with_attachments", {
    to: "recipient@example.com", subject: "Review", body: "Please review.", paths: ["notes.txt"],
  }, { directory: root }, {
    signal: controller.signal,
    readCloudMcp: async () => cloudMcp(),
    fetchImpl: async (_url, init) => {
      remoteCalls++;
      expect(init?.signal?.aborted).toBe(false);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("Aborted after dispatch", "AbortError");
    },
  })).rejects.toThrow("Aborted after dispatch");
  expect(remoteCalls).toBe(1);
});

test("Gmail transport preserves cloud rejection codes without asserting no creation", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "notes.txt"), "notes");
  for (const { status, error } of [{ status: 409, error: "needs_connection" }, { status: 502, error: "google_api_error" }]) {
    await expect(callOpenWorkCloudUploadAction(testConfig(root), "gmail_create_draft_with_attachments", {
      to: "recipient@example.com", subject: "Review", body: "Please review.", paths: ["notes.txt"],
    }, { directory: root }, {
      readCloudMcp: async () => cloudMcp(),
      fetchImpl: async () => Response.json({ error, message: "Actionable error." }, { status }),
    })).rejects.toMatchObject({ status, code: "cloud_upload_failed", details: { upstreamCode: error }, message: "OpenWork Cloud could not upload the file: Actionable error." });
  }
});

test("Gmail idle cancels the real loopback request before remote multipart dispatch", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "notes.txt"), "notes");
  const previousUrl = process.env.OPENWORK_SERVER_URL;
  const previousToken = process.env.OPENWORK_SERVER_TOKEN;
  let markPreparing: () => void = () => {};
  const preparing = new Promise<void>((resolve) => { markPreparing = resolve; });
  let markFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => { markFinished = resolve; });
  let remoteCalls = 0;
  let hostError: unknown;
  const fields = { to: "recipient@example.com", subject: "Review", body: "Please review." };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      await request.json();
      try {
        return Response.json(await callOpenWorkCloudUploadAction(testConfig(root), "gmail_create_draft_with_attachments", {
          ...fields, paths: ["notes.txt"],
        }, { directory: root }, {
          signal: request.signal,
          readCloudMcp: async () => {
            markPreparing();
            if (!request.signal.aborted) await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
            return cloudMcp();
          },
          fetchImpl: async () => { remoteCalls++; return Response.json({ ok: true, draftId: "draft_1" }); },
        }));
      } catch (error) {
        hostError = error;
        return error instanceof ApiError ? Response.json(formatError(error), { status: error.status }) : Response.json({}, { status: 500 });
      } finally {
        markFinished();
      }
    },
  });
  try {
    process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENWORK_SERVER_TOKEN = "fixture-host-token";
    const plugin = await OpenWorkExtensionsPreview({ directory: root }, {});
    const input = {
      tool: "openwork-cloud_execute_capability", sessionID: "ses_cancel", callID: "call_cancel",
      args: { name: "native:emc_selected:postCapabilitiesGoogleWorkspaceGmailDrafts", body: { ...fields, attachments: ["notes.txt"] } },
    };
    const output = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "file_input_requires_host", created: false, message: "Host upload required." }) }] };
    const result = plugin["tool.execute.after"](input, output).catch((error: unknown) => error);
    await preparing;
    await plugin.event({ event: { type: "session.status", properties: { sessionID: input.sessionID, status: { type: "idle" } } } });
    expect(await result).toMatchObject({ message: expect.stringContaining("creation outcome unknown; verify drafts before retrying") });
    await finished;
    expect(hostError).toMatchObject({ status: 499, code: "gmail_attachment_cancelled" });
    expect(remoteCalls).toBe(0);
    await expect(plugin["tool.execute.after"](input, output)).rejects.toThrow("already attempted");
  } finally {
    server.stop(true);
    if (previousUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = previousToken;
  }
});
