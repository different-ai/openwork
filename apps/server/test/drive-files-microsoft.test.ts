import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callDriveFileAction } from "../src/extensions/drive-files.js";
import type { CloudUploadDependencies } from "../src/extensions/cloud-uploads.js";
import type { DriveFileApprovalRequest, ServerConfig } from "../src/types.js";

const LINK = "https://contoso.sharepoint.com/:w:/s/team/EaBcD?e=1";
const ETAG = "\"{11111111-2222-3333-4444-555555555555},3\"";
const SAVED_ETAG = "\"{11111111-2222-3333-4444-555555555555},4\"";
const CONTENT = "hello world!";
const CHUNK = 32 * 320 * 1024;
type Call = { url: URL; method: string; headers: Headers; body: unknown };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "drive-microsoft-workspace-"));
  const state = await mkdtemp(join(tmpdir(), "drive-microsoft-state-"));
  const approvals: DriveFileApprovalRequest[] = [];
  const config: ServerConfig = {
    host: "127.0.0.1", port: 8787, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 30_000 }, corsOrigins: [], workspaces: [],
    authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
    configPath: join(state, "openwork.json"),
    driveFileApproval: async (request) => { approvals.push(request); return true; },
  };
  return { config, root, approvals, [Symbol.asyncDispose]: async () => { await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); } };
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1", driveId: "b!lib", parentId: "folder-1", name: "Plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    revision: ETAG, size: CONTENT.length, modifiedTime: "2026-10-20T10:00:00Z", webUrl: "https://contoso.sharepoint.com/sites/team/Plan.docx", ...overrides,
  };
}

/** A fake OpenWork Cloud; each test overrides only the answers it is about. */
function cloud(answer: (call: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  const dependencies: CloudUploadDependencies = {
    readCloudMcp: async () => ({ type: "remote", url: "https://cloud.test/mcp/agent", enabled: true, oauth: false, headers: { Authorization: "Bearer cloud-member-fixture" } }),
    fetchImpl: async (target, init) => {
      const body = init?.body instanceof Uint8Array ? init.body : typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const call = { url: new URL(String(target)), method: init?.method ?? "GET", headers: new Headers(init?.headers), body };
      calls.push(call);
      const overridden = answer(call);
      if (overridden) return overridden;
      const { pathname, searchParams } = call.url;
      if (pathname === "/v1/direct-downloads/microsoft-365/drive-files") {
        const pdf = searchParams.get("format") === "pdf";
        return Response.json({ ok: true, file: file(), download: { format: pdf ? "pdf" : null, mimeType: pdf ? "application/pdf" : file().mimeType, extension: pdf ? ".pdf" : null, size: pdf ? null : CONTENT.length, exported: pdf, maxBytes: 250 * 1024 * 1024 } });
      }
      if (pathname === "/v1/direct-downloads/microsoft-365/drive-files/content") {
        return searchParams.get("format") === "pdf"
          ? new Response("%PDF-unit", { status: 200 })
          : new Response(CONTENT, { status: 206, headers: { "content-range": `bytes 0-${CONTENT.length - 1}/${CONTENT.length}` } });
      }
      if (pathname === "/v1/direct-uploads/microsoft-365/drive-upload-sessions") {
        return Response.json({ ok: true, uploadToken: "sealed-upload-token", size: (body as { size: number }).size, chunkSize: CHUNK, expiresAt: "2026-10-30T10:00:00.000Z", replaces: { itemId: "item-1", driveId: "b!lib", previousRevision: ETAG } });
      }
      if (pathname === "/v1/direct-uploads/microsoft-365/drive-upload-sessions/content") {
        return Response.json({ ok: true, status: "complete", file: { id: "item-1", driveId: "b!lib", name: "Plan.docx", eTag: SAVED_ETAG, size: 13, webUrl: file().webUrl, mimeType: file().mimeType } });
      }
      return Response.json({ error: "not_found", message: `Unexpected ${call.method} ${pathname}` }, { status: 404 });
    },
  };
  return { calls, dependencies };
}

test("OneDrive and SharePoint links pull into the workspace through OpenWork Cloud and save back over the pulled version", async () => {
  await using workspace = await fixture();
  const { calls, dependencies } = cloud();
  const pulled = await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: LINK }, {}, dependencies) as Record<string, any>;
  assert.equal(pulled.path, join("drive", "Plan.docx"));
  assert.equal(await readFile(join(workspace.root, "drive", "Plan.docx"), "utf8"), CONTENT);
  assert.equal(calls[0].url.searchParams.get("url"), LINK);
  const content = calls.find(({ url }) => url.pathname.endsWith("/content"))!;
  assert.deepEqual([content.url.searchParams.get("itemId"), content.url.searchParams.get("driveId"), content.headers.get("range")], ["item-1", "b!lib", `bytes=0-${CONTENT.length - 1}`]);
  assert.deepEqual([workspace.approvals[0].provider, workspace.approvals[0].action], ["microsoft-365", "pull"]);

  const status = await callDriveFileAction(workspace.config, "drive_file_status", {}, {}, dependencies) as Record<string, any>;
  assert.deepEqual([status.files[0].provider, status.files[0].driveId, status.files[0].local, status.files[0].drive], ["microsoft-365", "b!lib", "unchanged", "unchanged"]);

  await writeFile(join(workspace.root, "drive", "Plan.docx"), `${CONTENT}!`);
  const saved = await callDriveFileAction(workspace.config, "drive_push_file", { path: "drive/Plan.docx" }, {}, dependencies) as Record<string, any>;
  const session = calls.find(({ url, method }) => method === "POST" && url.pathname.endsWith("/drive-upload-sessions"))!;
  assert.deepEqual(session.body, { size: 13, driveId: "b!lib", itemId: "item-1", baseRevision: ETAG });
  const part = calls.find(({ method }) => method === "PUT")!;
  assert.equal(part.url.searchParams.get("token"), "sealed-upload-token");
  assert.equal(part.headers.get("content-range"), "bytes 0-12/13");
  assert.equal(Buffer.from(part.body as Uint8Array).toString(), `${CONTENT}!`);
  assert.deepEqual([saved.mode, saved.file.revision, saved.previousRevision], ["replace", SAVED_ETAG, ETAG]);
  assert.equal(workspace.approvals.at(-1)!.provider, "microsoft-365");

  const again = await callDriveFileAction(workspace.config, "drive_push_file", { path: "drive/Plan.docx" }, {}, dependencies) as Record<string, any>;
  assert.equal(again.unchanged, true, "the link now records the saved version");
});

test("a newer version in Microsoft 365 stops the save before any bytes are sent", async () => {
  await using workspace = await fixture();
  const { calls, dependencies } = cloud(({ url, method }) => method === "POST" && url.pathname.endsWith("/drive-upload-sessions")
    ? Response.json({ error: "drive_conflict", message: "The file changed since this copy was downloaded, so it was not replaced.", currentRevision: SAVED_ETAG }, { status: 409 })
    : undefined);
  await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "item-1", driveId: "b!lib" }, {}, dependencies);
  await writeFile(join(workspace.root, "drive", "Plan.docx"), "edited");
  await assert.rejects(callDriveFileAction(workspace.config, "drive_push_file", { path: "drive/Plan.docx" }, {}, dependencies), /changed since this copy/);
  assert.equal(calls.some(({ method }) => method === "PUT"), false);
});

test("an uncertain part asks how much arrived and resumes the same upload", async () => {
  await using workspace = await fixture();
  let puts = 0;
  const { calls, dependencies } = cloud(({ url, method }) => {
    if (!url.pathname.endsWith("/drive-upload-sessions/content")) return undefined;
    if (method === "PUT" && ++puts === 1) return Response.json({ error: "upload_unconfirmed", message: "Microsoft did not confirm this part." }, { status: 502 });
    if (method === "GET") return Response.json({ ok: true, status: "partial", nextOffset: 0 });
    return undefined;
  });
  await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: LINK }, {}, dependencies);
  await writeFile(join(workspace.root, "drive", "Plan.docx"), "edited");
  const saved = await callDriveFileAction(workspace.config, "drive_push_file", { path: "drive/Plan.docx" }, {}, dependencies) as Record<string, any>;
  assert.equal(saved.file.revision, SAVED_ETAG);
  assert.equal(calls.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/drive-upload-sessions")).length, 1, "no second upload session");
  assert.deepEqual(calls.filter(({ url }) => url.pathname.endsWith("/drive-upload-sessions/content")).map(({ method }) => method), ["PUT", "GET", "PUT"]);
});

test("a PDF conversion is saved back as a copy next to the original, never over it", async () => {
  await using workspace = await fixture();
  const { calls, dependencies } = cloud();
  const pulled = await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: LINK, format: "pdf" }, {}, dependencies) as Record<string, any>;
  assert.equal(pulled.path, join("drive", "Plan.pdf"));
  await assert.rejects(callDriveFileAction(workspace.config, "drive_push_file", { path: pulled.path, mode: "replace" }, {}, dependencies), /cannot replace the original/);
  await writeFile(join(workspace.root, pulled.path), "%PDF-edited");
  await callDriveFileAction(workspace.config, "drive_push_file", { path: pulled.path }, {}, dependencies);
  const session = calls.find(({ url, method }) => method === "POST" && url.pathname.endsWith("/drive-upload-sessions"))!;
  assert.deepEqual(session.body, { size: 11, driveId: "b!lib", name: "Plan (edited).pdf", conflictBehavior: "rename", folderId: "folder-1" });
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: LINK, format: "xlsx" }, {}, dependencies), /only be converted to pdf/);
});

test("Google Drive ids and links keep using the Google routes", async () => {
  await using workspace = await fixture();
  const { calls, dependencies } = cloud();
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "1AbCdEfGhIjKlMnOp" }, {}, dependencies));
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit" }, {}, dependencies));
  assert.deepEqual(calls.map(({ url }) => url.pathname), ["/v1/direct-downloads/google-workspace/drive-files/1AbCdEfGhIjKlMnOp", "/v1/direct-downloads/google-workspace/drive-files/1AbCdEfGhIjKlMnOp"]);
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "item-1", driveId: "b!lib", connectionId: "google-workspace" }, {}, dependencies), /Microsoft 365 connection/);
});
