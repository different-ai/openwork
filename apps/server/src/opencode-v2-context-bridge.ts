import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { serve } from "./serve-node.js";
import { OpenWorkExtensionsPreview } from "./opencode-plugins/openwork-extensions-preview.js";
import { openworkReadTransport, type OpenworkReadTransport } from "./opencode-plugins/openwork-read-transport.js";
import { createV2ReadAdapter, readV2SessionActivity } from "./opencode-v2-read-adapter.js";
import { isRecord } from "./workspace-kv-store.js";
import { SESSION_LINK_METADATA_KEY, SESSION_PROMPT_SENDER_KEY, readSessionLink, sessionLinkMetadata } from "@openwork/types/session-link";
import { createV2BrowserBridge } from "./opencode-v2-browser-bridge.js";
import { DRIVE_UPLOAD_PERMISSION, GMAIL_DRAFT_PERMISSION, OPENWORK_CLOUD_UPLOADS_EXTENSION_ID, OUTLOOK_DRAFT_PERMISSION } from "./extensions/cloud-upload-constants.js";
import { createDriveFileTools, DRIVE_FILE_ACTIONS, type DriveFileAction } from "./opencode-plugins/drive-file-tools.js";
import { SESSION_GROUP_COMMAND_IDS } from "./opencode-plugins/openwork-session-groups.js";
import { ASK_FORM, ASK_WITHOUT_WAITING, askArgs, askFormArgs, formQuestions } from "./opencode-plugins/openwork-agent-questions.js";
import { askWithoutWaiting } from "./opencode-v2-background-questions.js";
import { loopbackFetch } from "./server-fetch.js";
import type { PrepareDriveUpload } from "./extensions/approved-drive-upload.js";
import type { FileSendApprovals, FileSendPolicy } from "./file-send-approval.js";
import { createSandboxToolsBridge } from "./sandbox-tools-bridge.js";
import type { ServerConfig } from "./types.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";

const requestSchema = z.object({
  name: z.enum(["openwork_context", "openwork_query", "openwork_execute", "openwork_skills", "openwork_skill_read", "openwork_skill_folder", "openwork_drive_upload", "openwork_gmail_draft", "openwork_outlook_draft", ASK_WITHOUT_WAITING, ASK_FORM, ...DRIVE_FILE_ACTIONS]),
  input: z.unknown(),
  sessionId: z.string().max(256).optional(),
  caller: z.object({
    directory: z.string().min(1).max(4096), messageId: z.string().min(1).max(256),
    callId: z.string().min(1).max(256), agent: z.string().min(1).max(256).optional(),
  }).strict().optional(),
});
const APPROVAL_WAIT_MS = 10 * 60_000;
const MAX_OPEN_QUESTIONS = 20;
const DRIVE_FILE_CALL_MS = 15 * 60_000;
const DRIVE_FILE_REFUSALS: Partial<Record<DriveFileAction, { subject: string; nothing: string }>> = {
  drive_pull_file: { subject: "replacing this local copy", nothing: "nothing was changed" },
  drive_push_file: { subject: "saving this file", nothing: "nothing was uploaded" },
};
const isDriveFileAction = (name: string): name is DriveFileAction => (DRIVE_FILE_ACTIONS as readonly string[]).includes(name);
const createdPermission = z.object({ data: z.object({ id: z.string(), effect: z.string() }) });
const repliedPermission = z.object({ type: z.literal("permission.replied"), data: z.object({ requestID: z.string(), reply: z.string() }) });

export type EngineConnection = { url: string; username: string; password: string };
export type EngineApproval = {
  directory: string; sessionId: string; messageId: string; callId: string; agent?: string;
  action: string; resources: string[]; metadata: Record<string, unknown>;
  subject: string; nothing: string;
  sessionApproval?: { resource: string; remembered: boolean };
  save?: string[];
  asked?: (requestId: string) => void;
};

export async function askEngineApproval(engine: EngineConnection | undefined, approval: EngineApproval, signal: AbortSignal): Promise<"once" | "always" | "remembered"> {
  const { subject, nothing } = approval;
  if (!engine) throw new Error(`OpenWork cannot ask for your approval right now, so ${nothing}.`);
  const location = `location[directory]=${encodeURIComponent(approval.directory)}`;
  const authorization = `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`;
  const watching = new AbortController();
  const stop = AbortSignal.any([signal, watching.signal]);
  try {
    const events = await loopbackFetch(new URL(`/api/event?${location}`, engine.url), { headers: { authorization, accept: "text/event-stream" }, signal: stop });
    if (!events.ok || !events.body) throw new Error(`OpenWork could not ask for your approval, so ${nothing}.`);
    const response = await loopbackFetch(new URL(`/api/session/${encodeURIComponent(approval.sessionId)}/permission?${location}`, engine.url), {
      method: "POST", headers: { authorization, "content-type": "application/json" }, signal: stop,
      body: JSON.stringify({
        action: approval.action,
        resources: approval.sessionApproval ? [...approval.resources, approval.sessionApproval.resource] : approval.resources,
        save: approval.sessionApproval ? [...approval.resources, approval.sessionApproval.resource] : approval.save ?? [], metadata: approval.metadata,
        source: { type: "tool", messageID: approval.messageId, id: approval.callId }, ...(approval.agent ? { agent: approval.agent } : {}),
      }),
    });
    const created = createdPermission.safeParse(await response.json().catch(() => null));
    if (!response.ok || !created.success) throw new Error(`OpenWork could not ask for your approval, so ${nothing}.`);
    if (created.data.data.effect === "deny") throw new Error(`Your permissions do not allow ${subject}, so ${nothing}.`);
    if (created.data.data.effect === "allow" && approval.sessionApproval?.remembered) return "remembered";
    if (created.data.data.effect !== "ask") throw new Error(`${subject[0]?.toUpperCase()}${subject.slice(1)} was not shown to you for approval, so ${nothing}.`);
    approval.asked?.(created.data.data.id);
    const reader = events.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`The approval closed before you answered, so ${nothing}.`);
      const frames = (buffered + chunk.value).split(/\r?\n\r?\n/);
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
        let event: unknown;
        try { event = JSON.parse(data); } catch { continue; }
        const replied = repliedPermission.safeParse(event);
        if (!replied.success || replied.data.data.requestID !== created.data.data.id) continue;
        if (replied.data.data.reply === "once" || replied.data.data.reply === "always") return replied.data.data.reply;
        throw new Error(`You declined ${subject}, so ${nothing}.`);
      }
    }
  } finally {
    watching.abort();
  }
}
const rendererSessionCommandIds = ["session.archive", "session.pin", "session.rename", "session.set_model"];
const commandIds: readonly string[] = [
  ...SESSION_GROUP_COMMAND_IDS, ...rendererSessionCommandIds,
  "session.create", "session.send", "session.question.answer", "automation.propose", "agent.propose",
];
const questionReplyRoute = /^\/workspace\/[^/]+\/opencode2\/api\/session\/[^/]+\/form\/[^/]+\/reply$/;
const windowCommandIds: readonly string[] = [...rendererSessionCommandIds, "workspace.reload_sessions", "session.open"];
const sessionWriteRoute = /^\/workspace\/([^/]+)\/opencode\/session(?:\/([^/]+)\/prompt_async)?$/;
export function isQuestionReplyPath(path: string): boolean {
  return questionReplyRoute.test(path) && new URL(path, "http://127.0.0.1").pathname === path;
}
type Post = (path: string, body: Record<string, unknown>) => Promise<unknown>;
export async function postV2SessionWrite(path: string, body: Record<string, unknown>, post: Post): Promise<unknown> {
  const match = sessionWriteRoute.exec(path);
  if (!match || new URL(path, "http://127.0.0.1").pathname !== path) return undefined;
  const base = `/workspace/${match[1]}/opencode2/api/session`;
  const sessionId = match[2];
  if (!sessionId) {
    const link = isRecord(body.metadata) ? readSessionLink(body.metadata[SESSION_LINK_METADATA_KEY]) : null;
    const created = await post(base, {
      ...(typeof body.title === "string" ? { title: body.title } : {}), ...(isRecord(body.model) ? { model: body.model } : {}),
      ...(link ? { metadata: sessionLinkMetadata(link) } : {}),
    });
    const row = isRecord(created) && "data" in created ? created.data : created;
    const info = isRecord(row) && isRecord(row.info) ? row.info : row;
    if (!isRecord(info) || typeof info.id !== "string") throw new Error("Invalid engine session response");
    const model = info.model;
    return {
      id: info.id, title: typeof info.title === "string" ? info.title : null,
      model: isRecord(model) && typeof model.providerID === "string" && typeof model.id === "string" ? model : null,
    };
  }
  const model = isRecord(body.model) ? body.model : undefined;
  if (model && typeof model.providerID === "string" && typeof model.modelID === "string") {
    await post(`${base}/${sessionId}/model`, { model: {
      providerID: model.providerID, id: model.modelID, ...(typeof body.variant === "string" ? { variant: body.variant } : {}),
    } });
  }
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const text = parts.map(part => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
  await post(`${base}/${sessionId}/prompt`, {
    text, ...(typeof body.messageID === "string" ? { id: body.messageID } : {}), delivery: "steer",
    ...(typeof body.sentBy === "string" && body.sentBy ? { metadata: { [SESSION_PROMPT_SENDER_KEY]: body.sentBy } } : {}),
  });
  return null;
}
const sessionGroupRoute = /^\/workspace\/[^/]+\/session-groups(?:\/assignments\/[^/]+|\/[^/]+)?$/;
export function isSessionGroupWritePath(path: string): boolean {
  const url = new URL(path, "http://127.0.0.1");
  const [rawPath = "", rawQuery] = path.split("?", 2);
  if (url.pathname !== rawPath || url.hash) return false;
  if (rawQuery !== undefined && [...url.searchParams.keys()].some(key => key !== "destinationGroupId")) return false;
  return sessionGroupRoute.test(rawPath);
}
const driveUploadSchema = z.object({ path: z.string().min(1), folderId: z.string().optional(), connectionId: z.string().optional() }).strict();
const gmailDraftSchema = z.object({
  to: z.string().min(1), cc: z.string().optional(), bcc: z.string().optional(), subject: z.string().min(1), body: z.string().min(1),
  threadId: z.string().min(1).optional(), connectionId: z.string().optional(), paths: z.array(z.string().min(1)).min(1).max(10),
}).strict();
const addresses = z.array(z.string().min(1)).max(50).optional();
const outlookDraftSchema = z.object({
  to: addresses, cc: addresses, bcc: addresses, subject: z.string().min(1).optional(), body: z.string(), bodyContentType: z.enum(["text", "html"]).optional(),
  replyToMessageId: z.string().min(1).optional(), connectionId: z.string().optional(),
  paths: z.array(z.string().min(1)).min(1).max(10),
}).strict();
function bridgeAffordances(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(bridgeAffordances);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key === "affordances" || key === "availableAffordances"
      ? Array.isArray(entry) ? entry.filter(item => isRecord(item)
        && (item.kind === "query" || commandIds.includes(String(item.id)))
        && (!isRecord(item.executor) || item.executor.kind === "openwork")) : entry
      : bridgeAffordances(entry)]));
}

export async function createV2ContextBridge(
  hostRequest: (path: string, init?: RequestInit) => Promise<unknown>,
  engine?: () => EngineConnection | undefined,
  prepareDriveUpload?: PrepareDriveUpload,
  fileSends?: { approvals: FileSendApprovals; approvedRequest: (path: string, init?: RequestInit) => Promise<unknown> },
  sandboxConfig?: ServerConfig,
) {
  const token = randomBytes(32).toString("base64url");
  const plugin = await OpenWorkExtensionsPreview();
  const questions = new AbortController();
  let openQuestions = 0;
  const rememberedDriveUploads = new Set<string>();
  const driveApprovalRevisions = new Map<string, number>();
  const driveApprovalEpoch = randomBytes(16).toString("hex");
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/read") return new Response(null, { status: 404 });
    try {
      const text = await request.text();
      if (text.length > 64_000) return new Response(null, { status: 413 });
      const call = requestSchema.parse(JSON.parse(text));
      if (sandboxConfig && (isDriveFileAction(call.name) || ["openwork_drive_upload", "openwork_gmail_draft", "openwork_outlook_draft"].includes(call.name))) {
        await managedDesktopPolicy(sandboxConfig).assertHostExecution();
      }
      let deadline = AbortSignal.timeout(60_000);
      const read = (path: string, init?: RequestInit) => {
        const signal = AbortSignal.any([request.signal, deadline, ...(init?.signal ? [init.signal] : [])]);
        signal.throwIfAborted();
        return hostRequest(path, { ...init, signal });
      };
      const approveFileSend = (policy: FileSendPolicy, sessionId: string, caller: NonNullable<typeof call.caller>, send: {
        kind: string; paths: readonly string[]; account?: string; fileIdentity?: string;
        metadata: Record<string, unknown>; subject: string; nothing: string;
      }) => {
        if (!fileSends) throw new Error(`OpenWork cannot ask for your approval right now, so ${send.nothing}.`);
        const current = engine?.();
        return fileSends.approvals.approve(policy, {
          kind: send.kind, directory: caller.directory, sessionId, paths: send.paths,
          ...(caller.agent ? { agent: caller.agent } : {}), ...(current ? { engineUrl: current.url } : {}),
          ...(send.account ? { account: send.account } : {}), ...(send.fileIdentity ? { fileIdentity: send.fileIdentity } : {}),
        }, send.nothing, async prompt => {
          const reply = await askEngineApproval(current, {
            directory: caller.directory, sessionId, messageId: caller.messageId, callId: caller.callId, ...(caller.agent ? { agent: caller.agent } : {}),
            action: send.kind, resources: prompt.resources, save: prompt.save, asked: prompt.asked,
            metadata: { ...send.metadata, ...prompt.metadata }, subject: send.subject, nothing: send.nothing,
          }, AbortSignal.any([request.signal, AbortSignal.timeout(APPROVAL_WAIT_MS)]));
          return reply === "always" ? "always" : "once";
        });
      };
      if (call.name === "openwork_skills") {
        return Response.json(await read("/experimental/connect/skills"));
      }
      if (call.name === "openwork_skill_read") {
        const url = z.string().startsWith("skill://").max(2_048);
        const input = z.union([
          z.object({ url }).strict(),
          z.object({ urls: z.array(url).min(1).max(150), use: z.boolean().optional() }).strict(),
        ]).parse(call.input);
        return Response.json(await read("/experimental/connect/skills/read", { method: "POST", body: JSON.stringify(input) }));
      }
      if (call.name === "openwork_skill_folder") {
        const input = z.object({ url: z.string().startsWith("skill://").endsWith("/SKILL.md").max(2_048) }).strict().parse(call.input);
        return Response.json(await read("/experimental/connect/skills/folder", { method: "POST", body: JSON.stringify(input) }));
      }
      if (call.name === ASK_WITHOUT_WAITING || call.name === ASK_FORM) {
        const form = call.name === ASK_FORM ? askFormArgs.parse(call.input) : undefined;
        const args = form ? { questions: formQuestions(form) } : askArgs.parse(call.input);
        const current = engine?.();
        if (!call.sessionId || !call.caller || !current) throw new Error("OpenWork cannot ask the person from here, so nothing was asked.");
        if (openQuestions >= MAX_OPEN_QUESTIONS) throw new Error("Too many questions are waiting for answers, so nothing was asked. Wait for the person to answer one first.");
        const asked = await askWithoutWaiting(current, { directory: call.caller.directory, sessionId: call.sessionId, questions: args.questions, ...(form ? { form } : {}) }, request.signal, questions.signal);
        openQuestions += 1;
        void asked.settled.finally(() => { openQuestions -= 1; });
        return Response.json({ ok: true, id: asked.id, message: "Asked. Their answer arrives as a message in this chat; keep working on what does not depend on it." });
      }
      if (call.name === "openwork_drive_upload") {
        const args = driveUploadSchema.parse(call.input);
        if (!call.sessionId || !call.caller) throw new Error("This OpenWork engine cannot ask for your approval, so nothing was uploaded.");
        const prepared = await prepareDriveUpload?.(args, { directory: call.caller.directory }, request.signal);
        try {
          const path = prepared?.path ?? args.path;
          const currentEngine = engine?.();
          const { directory } = call.caller;
          const upload = async () => Response.json(prepared ? await prepared.upload() : await hostRequest("/experimental/extensions/call", { method: "POST", signal: request.signal, body: JSON.stringify({
            extensionId: OPENWORK_CLOUD_UPLOADS_EXTENSION_ID, action: "drive_upload_file", args, context: { directory },
          }) }));
          const sendPolicy = await fileSends?.approvals.policy();
          if (sendPolicy) {
            await approveFileSend(sendPolicy, call.sessionId, call.caller, {
              kind: DRIVE_UPLOAD_PERMISSION, paths: [path], subject: "this upload", nothing: "nothing was uploaded",
              ...(args.connectionId ? { account: args.connectionId } : {}), ...(prepared?.approvalIdentity ? { fileIdentity: prepared.approvalIdentity } : {}),
              metadata: { path, target: args.folderId ? `Google Drive folder ${args.folderId}` : "Google Drive", ...(args.connectionId ? { connectionId: args.connectionId } : {}) },
            });
            return await upload();
          }
          const scopeKey = prepared?.approvalIdentity && args.connectionId ? createHash("sha256").update(JSON.stringify([
            driveApprovalEpoch, currentEngine?.url, call.caller.directory, call.sessionId, call.caller.agent ?? null,
            path, prepared.approvalIdentity, args.folderId ?? null, args.connectionId ?? null,
          ])).digest("hex") : undefined;
          const revision = scopeKey ? driveApprovalRevisions.get(scopeKey) ?? 0 : 0;
          const scope = scopeKey ? `drive-upload:${createHash("sha256").update(`${scopeKey}:${revision}`).digest("hex")}` : undefined;
          let decision: Awaited<ReturnType<typeof askEngineApproval>>;
          try {
            decision = await askEngineApproval(currentEngine, {
              directory: call.caller.directory, sessionId: call.sessionId, messageId: call.caller.messageId, callId: call.caller.callId,
              ...(call.caller.agent ? { agent: call.caller.agent } : {}), action: DRIVE_UPLOAD_PERMISSION,
              resources: !scope && prepared?.approvalIdentity ? [path, `drive-upload-request:${randomBytes(16).toString("hex")}`] : [path],
              metadata: { path, target: args.folderId ? `Google Drive folder ${args.folderId}` : "Google Drive", ...(args.connectionId ? { connectionId: args.connectionId } : {}) },
              subject: "this upload", nothing: "nothing was uploaded",
              ...(scope ? { sessionApproval: { resource: scope, remembered: rememberedDriveUploads.has(scope) } } : {}),
            }, AbortSignal.any([request.signal, AbortSignal.timeout(APPROVAL_WAIT_MS)]));
          } catch (error) {
            if (scope && scopeKey) {
              rememberedDriveUploads.delete(scope);
              driveApprovalRevisions.set(scopeKey, Math.max(driveApprovalRevisions.get(scopeKey) ?? 0, revision + 1));
            }
            throw error;
          }
          if (scope && decision === "always") rememberedDriveUploads.add(scope);
          else if (scope && decision === "once") rememberedDriveUploads.delete(scope);
          return await upload();
        } finally {
          await prepared?.close();
        }
      }
      if (call.name === "openwork_gmail_draft") {
        const args = gmailDraftSchema.parse(call.input);
        if (!call.sessionId || !call.caller) throw new Error("This OpenWork engine cannot ask for your approval, so no draft was created.");
        const metadata = {
          paths: args.paths, subject: args.subject, target: args.threadId ? `Gmail reply to ${args.to}` : `Gmail draft to ${args.to}`,
          ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        };
        const sendPolicy = await fileSends?.approvals.policy();
        if (sendPolicy) await approveFileSend(sendPolicy, call.sessionId, call.caller, {
          kind: GMAIL_DRAFT_PERMISSION, paths: args.paths, metadata, subject: "this draft", nothing: "no draft was created",
          ...(args.connectionId ? { account: args.connectionId } : {}),
        });
        else await askEngineApproval(engine?.(), {
          directory: call.caller.directory, sessionId: call.sessionId, messageId: call.caller.messageId, callId: call.caller.callId,
          ...(call.caller.agent ? { agent: call.caller.agent } : {}), action: GMAIL_DRAFT_PERMISSION, resources: args.paths,
          metadata, subject: "this draft", nothing: "no draft was created",
        }, AbortSignal.any([request.signal, AbortSignal.timeout(APPROVAL_WAIT_MS)]));
        deadline = AbortSignal.timeout(130_000);
        return Response.json(await read("/experimental/extensions/call", { method: "POST", body: JSON.stringify({
          extensionId: OPENWORK_CLOUD_UPLOADS_EXTENSION_ID, action: GMAIL_DRAFT_PERMISSION, args, context: { directory: call.caller.directory },
        }) }));
      }
      if (call.name === "openwork_outlook_draft") {
        const args = outlookDraftSchema.parse(call.input);
        if (!call.sessionId || !call.caller) throw new Error("This OpenWork engine cannot ask for your approval, so no draft was created.");
        const metadata = {
          paths: args.paths, ...(args.subject ? { subject: args.subject } : {}),
          target: args.replyToMessageId ? "Outlook reply draft" : `Outlook draft to ${(args.to ?? []).join(", ")}`,
          ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        };
        const sendPolicy = await fileSends?.approvals.policy();
        if (sendPolicy) await approveFileSend(sendPolicy, call.sessionId, call.caller, {
          kind: OUTLOOK_DRAFT_PERMISSION, paths: args.paths, metadata, subject: "this draft", nothing: "no draft was created",
          ...(args.connectionId ? { account: args.connectionId } : {}),
        });
        else await askEngineApproval(engine?.(), {
          directory: call.caller.directory, sessionId: call.sessionId, messageId: call.caller.messageId, callId: call.caller.callId,
          ...(call.caller.agent ? { agent: call.caller.agent } : {}), action: OUTLOOK_DRAFT_PERMISSION, resources: args.paths,
          metadata, subject: "this draft", nothing: "no draft was created",
        }, AbortSignal.any([request.signal, AbortSignal.timeout(APPROVAL_WAIT_MS)]));
        deadline = AbortSignal.timeout(130_000);
        return Response.json(await read("/experimental/extensions/call", { method: "POST", body: JSON.stringify({
          extensionId: OPENWORK_CLOUD_UPLOADS_EXTENSION_ID, action: OUTLOOK_DRAFT_PERMISSION, args, context: { directory: call.caller.directory },
        }) }));
      }
      if (isDriveFileAction(call.name)) {
        const { sessionId, caller } = call;
        let pushApprovedInChat = false;
        const tools = createDriveFileTools((action, args) => {
          deadline = AbortSignal.timeout(DRIVE_FILE_CALL_MS);
          const approved = action === "drive_push_file" && pushApprovedInChat && fileSends ? fileSends.approvedRequest : undefined;
          const send = approved
            ? (path: string, init: RequestInit) => { const signal = AbortSignal.any([request.signal, deadline]); signal.throwIfAborted(); return approved(path, { ...init, signal }); }
            : read;
          return send("/experimental/drive-files/call", { method: "POST", body: JSON.stringify({
            action, args, context: { ...(sessionId ? { sessionId } : {}), ...(caller ? { directory: caller.directory, messageId: caller.messageId } : {}) },
          }) });
        });
        const refusal = DRIVE_FILE_REFUSALS[call.name] ?? { subject: "this Drive change", nothing: "nothing was changed" };
        const ask = async ({ permission, patterns, metadata }: { permission: string; patterns: string[]; metadata: Record<string, unknown> }) => {
          if (!sessionId || !caller) throw new Error(`This OpenWork engine cannot ask for your approval, so ${refusal.nothing}.`);
          const sendPolicy = permission === "drive_push_file" ? await fileSends?.approvals.policy() : null;
          if (sendPolicy) {
            await approveFileSend(sendPolicy, sessionId, caller, { kind: permission, paths: patterns, account: "source", metadata, ...refusal });
            pushApprovedInChat = true;
            return;
          }
          await askEngineApproval(engine?.(), {
            directory: caller.directory, sessionId, messageId: caller.messageId, callId: caller.callId, ...(caller.agent ? { agent: caller.agent } : {}),
            action: permission, resources: patterns, metadata, ...refusal,
          }, AbortSignal.any([request.signal, AbortSignal.timeout(APPROVAL_WAIT_MS)]));
        };
        return new Response(await tools[call.name].execute(call.input, { ask }), { headers: { "Content-Type": "application/json" } });
      }
      const transport: OpenworkReadTransport = {
        engine: "v2",
        activity: (workspaceId: string, sessionId: string) => readV2SessionActivity(path => read(path), workspaceId, sessionId),
        get: createV2ReadAdapter(path => read(path)),
        other: { engine: "v1", get: path => read(path) },
        post: async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          const execute = call.name === "openwork_execute";
          if (execute && path !== "/experimental/ui-control/request") {
            const written = await postV2SessionWrite(path, body, (target, payload) => read(target, { method: "POST", body: JSON.stringify(payload) }));
            if (written !== undefined) return written;
            if (isQuestionReplyPath(path)) return read(path, { method: "POST", body: JSON.stringify(body), signal });
          }
          const windowCommand = execute && body.kind === "command" && isRecord(body.input) && windowCommandIds.includes(String(body.input.id));
          if (path !== "/experimental/ui-control/request" || (!["context", "query"].includes(String(body.kind)) && !windowCommand)) {
            throw new Error("Only OpenWork reads are available");
          }
          return read(path, { method: "POST", body: JSON.stringify(body), signal });
        },
        ...(call.name === "openwork_execute" ? {
          send: async (method: "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>) => {
            if (!isSessionGroupWritePath(path)) throw new Error("Only OpenWork session group changes are available");
            return read(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
          },
        } : {}),
      };
      const result = await openworkReadTransport.run(transport, async () => {
        if (call.name === "openwork_query") return plugin.tool.openwork_query.execute(call.input, call.sessionId ? { sessionID: call.sessionId } : {});
        if (call.name === "openwork_execute") {
          const id = isRecord(call.input) ? String(call.input.id) : "";
          if (id === "session.group.list") throw new Error("session.group.list only reads. Call it with openwork_query.");
          if (!commandIds.includes(id)) throw new Error(`${id || "This command"} is not available here. Use openwork_context to find supported commands.`);
          const { sessionId, caller } = call;
          const ask = sessionId && caller ? async (approval: { permission: string; patterns: string[]; metadata: Record<string, unknown> }) => {
            await askEngineApproval(engine?.(), {
              directory: caller.directory, sessionId, messageId: caller.messageId, callId: caller.callId, ...(caller.agent ? { agent: caller.agent } : {}),
              action: approval.permission, resources: approval.patterns, metadata: approval.metadata,
              subject: "answering this question", nothing: "the question was not answered",
            }, AbortSignal.any([request.signal, AbortSignal.timeout(APPROVAL_WAIT_MS)]));
            deadline = AbortSignal.timeout(60_000);
          } : undefined;
          return plugin.tool.openwork_execute.execute(call.input, { ...(sessionId ? { sessionID: sessionId } : {}), ...(ask ? { ask } : {}) });
        }
        const context: unknown = JSON.parse(await plugin.tool.openwork_context.execute());
        const filtered = bridgeAffordances(context);
        return JSON.stringify(isRecord(filtered) ? { ...filtered, instructions: {
          context: "Use openwork_query for discovered read-only affordances and openwork_execute for session.archive (including unarchive), session.pin (pin/unpin), session.rename, session.set_model, session.group commands, session.create, session.send, session.question.answer or the proposal commands automation.propose and agent.propose. In a new agent chat, propose before checking any tools or connections and list only connections explicitly asked for or clearly needed. Follow the discovered arguments and safety requirements; working sessions cannot be archived or rebound. An automation proposal only shows a review card; it does not create, activate, or run anything. When Code Mode exposes these tools, discover their exact paths with search and compose them there, preserving exceptions and verifying the resulting groups. For other conversations, use session.search then session.read. Session reads include current activity and background-agent counts."
        } } : filtered);
      });
      return new Response(result, { headers: { "Content-Type": "application/json" } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "OpenWork read failed" }, { status: 400 });
    }
  } });
  const browser = await createV2BrowserBridge(sandboxConfig ? () => managedDesktopPolicy(sandboxConfig).assertHostExecution() : undefined).catch(async error => { await server.stop(); await plugin.dispose(); throw error; });
  const sandbox = sandboxConfig ? await createSandboxToolsBridge(sandboxConfig).catch(async error => {
    await browser.close(); await server.stop(); await plugin.dispose(); throw error;
  }) : undefined;
  return { url: `http://127.0.0.1:${server.port}/read`, token, browser: { url: browser.url, token: browser.token },
    ...(sandbox ? { sandbox: { url: sandbox.url, token: sandbox.token } } : {}),
    close: async () => { questions.abort(); await sandbox?.close(); await browser.close(); await server.stop(); await plugin.dispose(); } };
}
