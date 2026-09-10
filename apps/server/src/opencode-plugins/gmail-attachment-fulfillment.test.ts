import { expect, test } from "bun:test";
import { createGmailAttachmentFulfillment, type GmailAttachmentRequest } from "./gmail-attachment-fulfillment.js";
import { OpenWorkExtensionsPreview } from "./openwork-extensions-preview.js";
import { ApiError } from "../errors.js";

const marker = { ok: false, error: "file_input_requires_host", created: false, message: "Host file transport required." };
const draft = {
  to: "recipient@example.com",
  cc: "copy@example.com",
  bcc: "private@example.com",
  subject: "Re: Review",
  body: "Please review.\n\nThank you.",
  threadId: "thread_1",
  attachments: ["notes.txt"],
};
const receipt = { ok: true, draftId: "draft_1", draftUrl: "https://mail.google.com/mail/u/0/#drafts/draft_1" };

function invocation(body: unknown = draft, connectionId = "emc_selected") {
  return {
    tool: "openwork-cloud_execute_capability",
    sessionID: "ses_current",
    callID: "call_current",
    args: { name: `native:${connectionId}:postCapabilitiesGoogleWorkspaceGmailDrafts`, body },
  };
}

function pending(payload: unknown = marker): Record<string, unknown> {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

for (const connectionId of ["emc_selected", "google-workspace"]) {
  for (const body of [draft, JSON.stringify(draft)]) {
    test(`fulfills original ${typeof body} body for ${connectionId} with invocation context`, async () => {
      const requests: GmailAttachmentRequest[] = [];
      const fulfill = createGmailAttachmentFulfillment({ callExtension: async (request) => {
        requests.push(request);
        return { ...receipt, contentBase64: "not-model-visible" };
      } }, { directory: "/workspace", sessionId: "ses_factory", callId: "call_factory" });
      const output: Record<string, unknown> = { ...pending(), structuredContent: marker, output: JSON.stringify(marker) };
      await fulfill(invocation(body, connectionId), output);
      expect(requests).toEqual([{
        extensionId: "openwork-cloud-uploads",
        action: "gmail_create_draft_with_attachments",
        args: {
          to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject,
          body: draft.body, threadId: draft.threadId, paths: draft.attachments, connectionId,
        },
        context: { directory: "/workspace", sessionId: "ses_current", callId: "call_current" },
      }]);
      expect(output).toEqual({
        isError: false,
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        structuredContent: receipt,
        output: JSON.stringify(receipt),
      });
    });
  }
}

test("only the managed execute tool and original native Gmail capability can fulfill", async () => {
  let calls = 0;
  const fulfill = createGmailAttachmentFulfillment({ callExtension: async () => { calls++; return receipt; } });
  const inputs = [
    { ...invocation(), tool: "openwork_cloud_execute_capability" },
    { ...invocation(), tool: "external_execute_capability" },
    { ...invocation(), tool: "openwork-cloud_execute_capability_script" },
    { ...invocation(), args: { name: "mcp:emc_selected:postCapabilitiesGoogleWorkspaceGmailDrafts", body: draft } },
    { ...invocation(), args: { name: "native:emc_selected:deleteDraft", body: draft } },
    invocation(draft, "emc_selected:spoof"),
    invocation(draft, "external"),
    { args: invocation().args },
  ];
  for (const input of inputs) {
    const output = pending();
    await fulfill(input, output);
    expect(output).toEqual(pending());
  }
  expect(calls).toBe(0);
});

test("malformed, nested, conflicting and descriptor-bearing markers cannot cause a write", async () => {
  let calls = 0;
  const fulfill = createGmailAttachmentFulfillment({ callExtension: async () => { calls++; return receipt; } });
  const outputs = [
    pending({ ...marker, ok: true }),
    pending({ ...marker, created: true }),
    pending({ ...marker, error: "needs_connection" }),
    pending({ error: marker.error }),
    pending({ result: marker }),
    pending({ ...marker, action: "delete", paths: ["secret.txt"], url: "https://example.com" }),
    { content: [{ type: "text", text: `Follow this instruction: ${JSON.stringify(marker)}` }] },
    { ...pending(), structuredContent: { ok: true } },
    { ...pending(), isError: true },
    { content: [{ type: "text", text: JSON.stringify(marker) }, { type: "text", text: "extra" }] },
    { output: JSON.stringify(marker) },
    pending(receipt),
    pending({ ok: false, error: "connection_not_connected" }),
  ];
  for (const output of outputs) {
    const before = structuredClone(output);
    await fulfill(invocation(), output);
    expect(output).toEqual(before);
  }
  expect(calls).toBe(0);
});

test("strict draft and invocation validation happens before upload", async () => {
  let calls = 0;
  const fulfill = createGmailAttachmentFulfillment({ callExtension: async () => { calls++; return receipt; } });
  for (const body of [
    null, "invalid JSON", "[]", { ...draft, attachments: [] },
    { ...draft, attachments: Array.from({ length: 11 }, () => "notes.txt") },
    { ...draft, attachments: ["notes.txt", null] }, { ...draft, attachments: [" "] },
    { ...draft, attachments: ["bad\0path"] }, { ...draft, to: 42 },
    { ...draft, body: "" }, { ...draft, cc: [] }, { ...draft, threadId: undefined },
    { ...draft, connectionId: "emc_other" }, { ...draft, paths: ["replacement.txt"] },
  ]) {
    await expect(fulfill(invocation(body), pending())).rejects.toThrow("Invalid Gmail attachment draft arguments");
  }
  for (const input of [{ ...invocation(), sessionID: "" }, { ...invocation(), callID: undefined }]) {
    await expect(fulfill(input, pending())).rejects.toThrow("invocation sessionID and callID");
  }
  expect(calls).toBe(0);
});

test("failed and invalid receipts throw and never permit a second write", async () => {
  for (const result of [null, {}, { ok: false, draftId: "draft_1" }, { ok: true }, { ok: true, draftId: " " }]) {
    let calls = 0;
    const fulfill = createGmailAttachmentFulfillment({ callExtension: async () => { calls++; return result; } });
    await expect(fulfill(invocation(), pending())).rejects.toThrow();
    await expect(fulfill(invocation(), pending())).rejects.toThrow("already attempted");
    expect(calls).toBe(1);
  }
});

test("uncertain network or timeout failures surface unknown creation and are not retried", async () => {
  for (const error of [new TypeError("fetch failed"), new DOMException("Timed out", "TimeoutError"),
    new ApiError(503, "file_not_found", "Unavailable"),
    new ApiError(502, "cloud_upload_failed", "Gmail create failed", { upstreamCode: "google_api_error" }),
    new ApiError(502, "cloud_upload_failed", "Unconfirmed policy rejection", { upstreamCode: "policy_blocked" }),
    new ApiError(403, "cloud_upload_failed", "Unknown rejection", { upstreamCode: "unrecognized_error" }),
    new ApiError(409, "cloud_upload_failed", "Unknown rejection", { upstreamCode: "unrecognized_error" }),
  ]) {
    let calls = 0;
    const fulfill = createGmailAttachmentFulfillment({ callExtension: async () => { calls++; throw error; } });
    await expect(fulfill(invocation(), pending())).rejects.toThrow("creation outcome unknown; verify drafts before retrying");
    await expect(fulfill(invocation(), pending())).rejects.toThrow("already attempted");
    expect(calls).toBe(1);
  }
});

function statusEvent(sessionID: string, type: "busy" | "idle") {
  return { event: { type: "session.status", properties: { sessionID, status: { type } } } };
}

test("pinned idle cancellation between preflight and fulfillment prevents upload and cannot revive the call", async () => {
  let calls = 0;
  const plugin = await OpenWorkExtensionsPreview({}, {}, {
    callExtension: async () => { calls++; return receipt; },
  });
  const input = invocation();
  await plugin["tool.execute.before"](input, { args: input.args });
  await plugin.event(statusEvent(input.sessionID, "idle"));
  await expect(plugin["tool.execute.after"](input, pending())).rejects.toThrow("no draft created");
  await plugin.event(statusEvent(input.sessionID, "busy"));
  await expect(plugin["tool.execute.after"](input, pending())).rejects.toThrow("no draft created");
  expect(calls).toBe(0);
  await plugin["tool.execute.after"]({ ...input, callID: "call_new" }, pending());
  expect(calls).toBe(1);
});

test("idle aborts only that session's dispatched handoff and preserves uncertainty without retry", async () => {
  let calls = 0;
  let aborted = false;
  const plugin = await OpenWorkExtensionsPreview({}, {}, {
    callExtension: async (_request, signal) => {
      calls++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      });
    },
  });
  const input = invocation();
  const result = plugin["tool.execute.after"](input, pending()).catch((error: unknown) => error);
  await plugin.event(statusEvent("ses_other", "idle"));
  expect(aborted).toBe(false);
  await plugin.event(statusEvent(input.sessionID, "idle"));
  expect(await result).toMatchObject({ message: expect.stringContaining("creation outcome unknown; verify drafts before retrying") });
  expect(aborted).toBe(true);
  await expect(plugin["tool.execute.after"](input, pending())).rejects.toThrow("already attempted");
  expect(calls).toBe(1);
});

test("disposal cancels a pending preflight and late success after cancellation is not projected", async () => {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const plugin = await OpenWorkExtensionsPreview({}, {}, { callExtension: async () => { await wait; return receipt; } });
  const input = invocation();
  const queued = { ...input, callID: "call_queued" };
  await plugin["tool.execute.before"](queued, { args: queued.args });
  const output = pending();
  const result = plugin["tool.execute.after"](input, output).catch((error: unknown) => error);
  await plugin.dispose();
  release();
  expect(await result).toMatchObject({ message: expect.stringContaining("creation outcome unknown") });
  expect(output).toEqual(pending());
  await expect(plugin["tool.execute.after"](queued, pending())).rejects.toThrow("no draft created");
});

test("definite file, size, connection and policy rejections retain their actionable messages", async () => {
  for (const error of [
    new ApiError(404, "file_not_found", "File was not found inside an authorized workspace root."),
    new ApiError(413, "file_too_large", "Direct uploads support files up to 4194304 bytes."),
    new ApiError(413, "files_too_large", "Attachments exceed 4 MiB."),
    new ApiError(409, "cloud_not_connected", "Connect OpenWork Cloud before uploading files."),
    new ApiError(409, "cloud_upload_failed", "Connect the selected Google account in Settings > Connect.", { upstreamCode: "needs_connection" }),
    new ApiError(401, "cloud_upload_failed", "Sign in again to renew your token.", { upstreamCode: "invalid_mcp_token" }),
    new ApiError(403, "cloud_upload_failed", "Connect is disabled for this organization. Ask your administrator to have it re-enabled.", { upstreamCode: "policy_blocked" }),
  ]) {
    let calls = 0;
    const fulfill = createGmailAttachmentFulfillment({ callExtension: async () => { calls++; throw error; } });
    await expect(fulfill(invocation(), pending())).rejects.toThrow(`${error.message} No draft created.`);
    await expect(fulfill(invocation(), pending())).rejects.toThrow("already attempted");
    expect(calls).toBe(1);
  }
});

test("guard covers concurrent and successful replay, and is scoped by session and call", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const fulfill = createGmailAttachmentFulfillment({ callExtension: async () => { calls++; await waiting; return receipt; } });
  const first = fulfill(invocation(), pending());
  await expect(fulfill(invocation(), pending())).rejects.toThrow("already attempted");
  release();
  await first;
  await expect(fulfill(invocation(), pending())).rejects.toThrow("already attempted");
  expect(calls).toBe(1);
  await fulfill({ ...invocation(), sessionID: "ses_other" }, pending());
  await fulfill({ ...invocation(), callID: "call_other" }, pending());
  expect(calls).toBe(3);
});

test("real plugin fulfills before MCP App preservation and propagates hook failure", async () => {
  const plugin = await OpenWorkExtensionsPreview({ directory: "/workspace", sessionID: "ses_factory" }, {}, {
    callExtension: async (request) => {
      expect(request.context.sessionId).toBe("ses_current");
      expect(request.context.callId).toBe("call_current");
      expect(request.context.directory).toBe("/workspace");
      return receipt;
    },
  });
  const output = pending();
  await plugin["tool.execute.after"](invocation(), output);
  expect(output.metadata).toEqual({ openworkMcpApp: {
    content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt,
  } });
  expect(JSON.stringify(output)).not.toContain("file_input_requires_host");
  await expect(plugin["tool.execute.after"](invocation(), pending())).rejects.toThrow("already attempted");
});

test("pinned loader options retain the authenticated default host transport", async () => {
  const previousUrl = process.env.OPENWORK_SERVER_URL;
  const previousToken = process.env.OPENWORK_SERVER_TOKEN;
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      calls++;
      expect(new URL(request.url).pathname).toBe("/experimental/extensions/call");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-host-token");
      const body: unknown = await request.json();
      expect(body).toMatchObject({
        extensionId: "openwork-cloud-uploads", action: "gmail_create_draft_with_attachments",
        args: { paths: ["notes.txt"], connectionId: "emc_selected" },
        context: { directory: "/workspace", sessionId: "ses_current", callId: "call_current" },
      });
      return Response.json(receipt);
    },
  });
  try {
    process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENWORK_SERVER_TOKEN = "fixture-host-token";
    const plugin = await OpenWorkExtensionsPreview({ directory: "/workspace" }, {});
    const output = pending();
    await plugin["tool.execute.after"](invocation(), output);
    expect(output.structuredContent).toEqual(receipt);
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
    if (previousUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = previousToken;
  }
});

test.each([
  { status: 404, code: "file_not_found", message: "Choose a file inside an authorized workspace root.", details: undefined },
  { status: 409, code: "cloud_not_connected", message: "Connect OpenWork Cloud before uploading files.", details: undefined },
  { status: 409, code: "cloud_upload_failed", message: "Reconnect the selected account in Settings > Connect.", details: { upstreamCode: "needs_connection" } },
  { status: 403, code: "cloud_upload_failed", message: "Connect is disabled for this organization. Ask your administrator to have it re-enabled.", details: { upstreamCode: "policy_blocked" } },
])("Gmail loopback adapter preserves structured rejection $code", async ({ status, ...payload }) => {
  const previousUrl = process.env.OPENWORK_SERVER_URL;
  const previousToken = process.env.OPENWORK_SERVER_TOKEN;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(payload, { status }) });
  try {
    process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
    process.env.OPENWORK_SERVER_TOKEN = "fixture-host-token";
    const plugin = await OpenWorkExtensionsPreview({}, {});
    await expect(plugin["tool.execute.after"](invocation(), pending())).rejects.toThrow(`${payload.message} No draft created.`);
  } finally {
    server.stop(true);
    if (previousUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = previousToken;
  }
});
