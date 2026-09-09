import { z } from "zod";

const draftSchema = z.object({
  to: z.string().trim().min(3).max(320),
  cc: z.string().trim().min(3).max(1_000).optional(),
  bcc: z.string().trim().min(3).max(1_000).optional(),
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(50_000),
  threadId: z.string().trim().min(1).max(512).optional(),
  attachments: z.array(z.string().min(1).refine((path) => path.trim().length > 0 && !path.includes("\0"))).min(1).max(10),
}).strict().refine((draft) => !/^\s*(re|fwd?)\s*:/i.test(draft.subject) || !!draft.threadId);

const markerSchema = z.object({
  ok: z.literal(false),
  error: z.literal("file_input_requires_host"),
  created: z.literal(false),
  message: z.string(),
}).strict();

// Strip unexpected fields so neither inline bytes nor action descriptors can
// leak from a transport response into the model-visible draft receipt.
const receiptSchema = z.object({
  ok: z.literal(true),
  draftId: z.string().trim().min(1),
  messageId: z.string().nullable().optional(),
  draftUrl: z.string().nullable().optional(),
  threadUrl: z.string().nullable().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  threadId: z.string().nullable().optional(),
  quotedHistoryIncluded: z.boolean().optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
  })).optional(),
});

export type GmailAttachmentRequest = {
  extensionId: "openwork-cloud-uploads";
  action: "gmail_create_draft_with_attachments";
  args: Omit<z.infer<typeof draftSchema>, "attachments"> & { paths: string[]; connectionId: string };
  context: Record<string, unknown> & { sessionId: string; callId: string };
};

export type GmailAttachmentDependencies = {
  callExtension: (request: GmailAttachmentRequest, signal: AbortSignal) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

const UNKNOWN_OUTCOME = "Gmail draft creation outcome unknown; verify drafts before retrying. Do not retry automatically or create a draft without attachments.";
const CANCELLED_BEFORE_UPLOAD = "Gmail attachment upload cancelled before dispatch; no draft created.";
const NATIVE_GMAIL = /^native:(google-workspace|emc_[A-Za-z0-9]+):postCapabilitiesGoogleWorkspaceGmailDrafts$/;

// These exact code/status pairs are returned before draft creation. In
// particular, never classify google_api_error, a 5xx, or a lost response here.
const LOCAL_NO_WRITE = new Set([
  "invalid_payload:400", "file_not_found:404", "file_too_large:413", "files_too_large:413",
  "cloud_not_connected:409", "cloud_endpoint_invalid:409", "gmail_host_unavailable:409",
  "unauthorized:401", "forbidden:403", "gmail_attachment_cancelled:499",
]);
const CLOUD_NO_WRITE = new Set([
  "invalid_request:400", "invalid_request:413", "missing_thread_id:400",
  "needs_connection:409", "unauthorized:401", "forbidden:403",
  "missing_mcp_token:401", "invalid_mcp_token:401", "wrong_token_use:401", "wrong_mcp_resource:401",
  "missing_mcp_principal:401", "mcp_grant_revoked:401", "mcp_session_required:401", "mcp_session_revoked:401",
  "insufficient_mcp_scope:403", "mcp_membership_revoked:403",
]);

function noWriteMessage(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.message !== "string") return;
  if (LOCAL_NO_WRITE.has(`${error.code}:${error.status}`)) return `${error.message} No draft created.`;
  if (error.code === "cloud_upload_failed" && isRecord(error.details)
    && CLOUD_NO_WRITE.has(`${error.details.upstreamCode}:${error.status}`)) {
    return `${error.message} No draft created.`;
  }
}

export function createGmailAttachmentFulfillment(
  dependencies: GmailAttachmentDependencies,
  factoryContext: Record<string, unknown> = {},
) {
  // Retain invocation guards until disposal, including cancelled preflights.
  // A later busy event must not revive a previous call's cancelled controller.
  const calls = new Map<string, { sessionID: string; controller: AbortController; attempted: boolean }>();
  const idleSessions = new Set<string>();
  let disposed = false;
  function invocation(sessionID: string, callID: string) {
    const key = JSON.stringify([sessionID, callID]);
    const existing = calls.get(key);
    if (existing) return existing;
    const call = { sessionID, controller: new AbortController(), attempted: false };
    if (disposed || idleSessions.has(sessionID)) call.controller.abort();
    calls.set(key, call);
    return call;
  }
  const fulfill = async (input: unknown, output: unknown): Promise<void> => {
    // OpenCode 1.18.18 McpCatalog.toolName preserves hyphens in server names.
    if (!isRecord(input) || input.tool !== "openwork-cloud_execute_capability") return;
    if (!isRecord(input.args) || typeof input.args.name !== "string") return;
    const native = NATIVE_GMAIL.exec(input.args.name);
    const connectionId = native?.[1];
    if (!connectionId || !isRecord(output) || output.isError === true) return;

    // Only the whole native preflight payload is a marker, never embedded text
    // or a nested descriptor from an external MCP. Conflicting projections fail closed.
    if (!Array.isArray(output.content) || output.content.length !== 1) return;
    const part: unknown = output.content[0];
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return;
    if (!markerSchema.safeParse(normalizeJson(part.text)).success) return;
    if (output.structuredContent !== undefined && !markerSchema.safeParse(output.structuredContent).success) return;

    const draft = draftSchema.safeParse(normalizeJson(input.args.body));
    if (!draft.success) throw new Error("Invalid Gmail attachment draft arguments; no upload attempted.");
    if (typeof input.sessionID !== "string" || !input.sessionID.trim()
      || typeof input.callID !== "string" || !input.callID.trim()) {
      throw new Error("Gmail attachment fulfillment requires invocation sessionID and callID; no upload attempted.");
    }
    const call = invocation(input.sessionID, input.callID);
    if (call.attempted) throw new Error(`Gmail attachment invocation already attempted. ${UNKNOWN_OUTCOME}`);
    if (call.controller.signal.aborted) throw new Error(CANCELLED_BEFORE_UPLOAD);
    call.attempted = true;

    const { attachments, ...fields } = draft.data;
    let result: unknown;
    try {
      result = await dependencies.callExtension({
        extensionId: "openwork-cloud-uploads",
        action: "gmail_create_draft_with_attachments",
        args: { ...fields, paths: attachments, connectionId },
        context: { ...factoryContext, sessionId: input.sessionID, callId: input.callID },
      }, call.controller.signal);
    } catch (error) {
      const message = noWriteMessage(error);
      if (message) throw new Error(message);
      // A lost response cannot prove that Gmail did not create the draft.
      throw new Error(UNKNOWN_OUTCOME);
    }
    if (call.controller.signal.aborted) throw new Error(UNKNOWN_OUTCOME);
    if (isRecord(result) && result.ok === false) {
      throw new Error(UNKNOWN_OUTCOME);
    }
    const receipt = receiptSchema.safeParse(result);
    if (!receipt.success) throw new Error(UNKNOWN_OUTCOME);

    const text = JSON.stringify(receipt.data);
    // The pinned engine projects content AFTER this hook, not output. Keep
    // both consistent for consumers that already have a text projection.
    output.content = [{ type: "text", text }];
    output.structuredContent = receipt.data;
    if ("output" in output) output.output = text;
    output.isError = false;
    delete output._meta;
  };
  return Object.assign(fulfill, {
    before: async (input: unknown, output: unknown): Promise<void> => {
      if (!isRecord(input) || input.tool !== "openwork-cloud_execute_capability"
        || typeof input.sessionID !== "string" || typeof input.callID !== "string"
        || !isRecord(output) || !isRecord(output.args) || typeof output.args.name !== "string"
        || !NATIVE_GMAIL.test(output.args.name)) return;
      const body = normalizeJson(output.args.body);
      if (isRecord(body) && Array.isArray(body.attachments)) invocation(input.sessionID, input.callID);
    },
    event: async (input: unknown): Promise<void> => {
      // OpenCode 1.18.18 Runner.cancel -> onIdle -> SessionStatus.set;
      // Plugin.event receives { event: { type, properties } }. No input.abort exists.
      if (!isRecord(input) || !isRecord(input.event) || input.event.type !== "session.status") return;
      const props = input.event.properties;
      if (!isRecord(props) || typeof props.sessionID !== "string" || !isRecord(props.status)) return;
      if (props.status.type === "busy") idleSessions.delete(props.sessionID);
      if (props.status.type !== "idle") return;
      idleSessions.add(props.sessionID);
      for (const call of calls.values()) {
        if (call.sessionID === props.sessionID) call.controller.abort();
      }
    },
    dispose: async (): Promise<void> => {
      disposed = true;
      for (const call of calls.values()) call.controller.abort();
    },
  });
}
