import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { stopChild } from "../worlds/openwork-server-cli.ts";

// Keep the real desktop HTTP boundary; native Cloud Calendar coverage lives in
// den-api/test/google-workspace-capabilities.test.ts, not this retired extension.
async function calendarServer(cloudMember = false) {
  needs({ commands: ["bun"], placement: "local" });
  const root = await mkdtemp(join(tmpdir(), "google-retirement-"));
  const repo = resolve(import.meta.dirname, "../..");
  const config = join(root, "server.json");
  const workspace = join(root, "workspace");
  const extensions = join(root, "extensions");
  const legacyFiles = new Map<string, Buffer>();
  await mkdir(workspace);
  await mkdir(extensions);
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xfb, 0xef]);
  await writeFile(join(workspace, "review.docx"), bytes);
  await writeFile(config, JSON.stringify({ authorizedRoots: [workspace] }));
  if (cloudMember) {
    await writeFile(join(root, "connect-state.json"), JSON.stringify({
      connectEnabled: true,
      updatedAt: 1,
      cloudMcp: {
        type: "remote", enabled: true, oauth: false,
        url: "https://cloud.example.test/mcp/agent",
        headers: { Authorization: "Bearer cloud-member-fixture" },
      },
    }));
  } else {
    await mkdir(join(extensions, "google-workspace"));
    legacyFiles.set(join(extensions, "google-workspace", "oauth.dev-plaintext.json"), Buffer.from(JSON.stringify({
      version: 2, activeAccountId: "fixture-account", accounts: [{
        account: { email: "calendar@example.test", name: "Calendar fixture", sub: "fixture-account", picture: null },
        scopes: ["openid", "https://www.googleapis.com/auth/calendar.readonly"],
        // Expiry makes an accidental local read attempt refresh, which the witness rejects.
        token: { accessToken: "retired-access-fixture", refreshToken: "retired-refresh-fixture", expiresAt: 0 },
        connectedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
      }],
    })));
    legacyFiles.set(join(extensions, "google-workspace", "oauth.vault"), Buffer.from("retired-encrypted-fixture"));
    legacyFiles.set(join(extensions, "vault.key"), Buffer.from("retired-vault-key-fixture"));
    for (const [path, contents] of legacyFiles) await writeFile(path, contents);
  }
  const child = spawn("bun", ["--conditions=development", "--preload", join(repo, "evals/packages/labs/src/calendar-read-preload.ts"), "src/cli.ts",
    "--host", "127.0.0.1", "--port", "0", "--token", "calendar-client", "--host-token", "calendar-host", "--config", config,
  ], { cwd: join(repo, "apps/server"), env: {
    PATH: process.env.PATH, HOME: root, OPENWORK_SERVER_CONFIG: config, OPENWORK_DATA_DIR: join(root, "data"),
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    OPENWORK_DEV_MODE: "1", OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT: "1",
    ...(!cloudMember ? {
      GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "retired-client-fixture",
      GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "retired-secret-fixture",
      OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "retired-client-fixture",
      OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "retired-secret-fixture",
      OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL: "https://broker.example.test/token",
      GOOGLE_WORKSPACE_TOKEN_BROKER_URL: "https://broker.example.test/token",
    } : {}),
  }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    const base = await eventually(() => {
      if (child.exitCode !== null) throw new Error(output);
      return output.match(/OpenWork server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    }, { within: 60_000, intervalMs: 100 });
    const witness = output.match(/Calendar witness: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!witness) throw new Error("Calendar witness did not start");
    const requests = async () => (await fetch(witness, { signal: AbortSignal.timeout(10_000) })).json();
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, {
        ...init, headers: { authorization: "Bearer calendar-client", "content-type": "application/json", ...init?.headers },
        signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    };
    const call = (extensionId: string, action: string, args: Record<string, unknown> = {}) => request("/experimental/extensions/call", {
      method: "POST", body: JSON.stringify({ extensionId, action, args, context: { directory: workspace } }),
    });
    return { request, requests, call, legacyFiles, extensions, bytes, [Symbol.asyncDispose]: async () => {
      await stopChild(child);
      await rm(root, { recursive: true, force: true });
    } };
  } catch (error) {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const uploadArgs = {
  path: "review.docx", paths: ["review.docx"], folderId: "cloud-folder",
  to: "review@example.test", subject: "Review", body: "Please review.", threadId: "cloud-thread",
};

test("desktop retires every local Google action without using or changing legacy OAuth state", async ({ evidence, place }) => {
  console.log(`placement: ${place.kind} (PR lane resolved by testkit)`);
  await using calendar = await calendarServer();
  const actions = [
    "status", "calendar_list_events", "calendar_create_event", "gmail_create_draft", "gmail_create_reply_draft",
    "gmail_list_messages", "gmail_get_message", "gmail_download_attachment", "drive_search_files", "drive_read_file",
    "drive_update_file", "chat_list_spaces", "chat_list_messages", "chat_send_message",
    "connect", "connect_start", "connect_status", "config", "configure", "disconnect", "set_active_account", "test", "smoke_test", "unknown",
  ];
  for (const connectEnabled of [undefined, false, true]) {
    if (connectEnabled !== undefined) {
      expect(await calendar.request("/experimental/connect/state", {
        method: "PUT", headers: { "x-openwork-host-token": "calendar-host" }, body: JSON.stringify({ connectEnabled }),
      })).toMatchObject({ status: 200, body: { connectEnabled } });
    }
    const state = await calendar.request("/experimental/connect/state");
    expect(state.status).toBe(200);
    expect(state.body).not.toHaveProperty("googleWorkspace");
    expect(await calendar.request("/experimental/extensions/actions?extensionId=google-workspace")).toEqual({
      status: 200, body: { ok: true, schemaVersion: 1, actions: [] },
    });
    expect(await calendar.request("/experimental/extensions/actions")).toEqual({
      status: 200, body: { ok: true, schemaVersion: 1, actions: [
        expect.objectContaining({ extensionId: "openai-image-generation", action: "status" }),
        expect.objectContaining({ extensionId: "openai-image-generation", action: "image_generate" }),
        expect.objectContaining({ extensionId: "openwork-cloud-uploads", action: "drive_upload_file" }),
        expect.objectContaining({ extensionId: "openwork-cloud-uploads", action: "gmail_create_draft_with_attachments" }),
      ] },
    });
    for (const action of actions) {
      const result = await calendar.call("google-workspace", action, {
        ...uploadArgs, timeMin: "2026-09-01T07:00:00Z", timeMax: "2026-09-01T08:00:00Z",
        accountId: "fixture-account", messageId: "fixture-message", attachmentId: "fixture-attachment",
        query: "review", fileId: "fixture-file", content: "Review", spaceId: "fixture-space", text: "Review",
        summary: "Review", start: "2026-09-01T07:00:00Z", end: "2026-09-01T08:00:00Z",
      });
      expect(result, `${action}, Connect=${connectEnabled}`).toMatchObject({
        status: 200, body: {
          ok: false, error: "use_openwork_cloud", message: expect.stringContaining("local credentials cannot be used"),
          nextAction: { recommendedAction: "Open Settings > Library > Connections to check your Cloud connections, or Settings > Debug to diagnose OpenWork Cloud agent access for this workspace." },
        },
      });
      expect(result.body).not.toHaveProperty("result");
      expect(result.body).not.toHaveProperty("connected");
      expect(result.body).not.toHaveProperty("authUrl");
    }
    for (const action of ["drive_upload_file", "gmail_create_draft_with_attachments"]) {
      expect(await calendar.call("openwork-cloud-uploads", action, uploadArgs)).toMatchObject({ status: 409, body: { code: "cloud_not_connected" } });
    }
    expect(await calendar.call("openai-image-generation", "status")).toMatchObject({ status: 200, body: { ok: true, extensionId: "openai-image-generation", action: "status" } });
    expect(await calendar.requests()).toEqual({ externalRequests: [], cloudUploads: [] });
    for (const [path, bytes] of calendar.legacyFiles) expect(await readFile(path)).toEqual(bytes);
  }
  evidence.recordAssertionEvidence("Legacy Google cannot be discovered, executed, or reused for uploads",
    "With Connect absent, off, and on, all 24 retired/unknown actions refuse with use_openwork_cloud, including status and lifecycle/config calls. Both Cloud uploads require member auth; OpenAI status still executes. Zero external requests or uploads; all three seeded OAuth files remain byte-identical.", true);
});

test("desktop file bridge uploads exact bytes through Cloud member auth without local Google tokens", async ({ evidence, place }) => {
  console.log(`placement: ${place.kind} (PR lane resolved by testkit)`);
  await using calendar = await calendarServer(true);
  expect(await readdir(calendar.extensions)).toEqual([]);
  expect(await calendar.request("/experimental/extensions/actions?extensionId=google-workspace")).toMatchObject({ status: 200, body: { actions: [] } });
  expect(await calendar.call("google-workspace", "calendar_list_events", { timeMin: "2026-09-01T07:00:00Z", timeMax: "2026-09-01T08:00:00Z" }))
    .toMatchObject({ status: 200, body: { ok: false, error: "use_openwork_cloud" } });
  expect(await calendar.call("openwork-cloud-uploads", "drive_upload_file", uploadArgs)).toEqual({ status: 200, body: { ok: true, file: { id: "cloud-file" } } });
  expect(await calendar.call("openwork-cloud-uploads", "gmail_create_draft_with_attachments", uploadArgs)).toEqual({ status: 200, body: { ok: true, draftId: "cloud-draft", threadId: "cloud-thread" } });
  const file = { name: "review.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: [...calendar.bytes] };
  expect(await calendar.requests()).toEqual({
    externalRequests: [],
    cloudUploads: [
      { path: "/v1/direct-uploads/google-workspace/drive-files", authorization: "Bearer cloud-member-fixture", files: [file], fields: { folderId: "cloud-folder" } },
      { path: "/v1/direct-uploads/google-workspace/gmail-drafts", authorization: "Bearer cloud-member-fixture", files: [file], fields: {
        payload: JSON.stringify({ to: uploadArgs.to, subject: uploadArgs.subject, body: uploadArgs.body, threadId: uploadArgs.threadId }),
      } },
    ],
  });
  expect(await readdir(calendar.extensions)).toEqual([]);
  evidence.recordAssertionEvidence("Cloud file bridge survives local Google retirement",
    "Both HTTP extension calls send exact Office bytes, basename, MIME type, folder/reply metadata and only the synthetic Cloud member authorization to the Cloud witness. Results contain IDs, not file bytes. No direct provider requests or local OAuth files are created; local Calendar remains refused.", true);
});
