/**
 * Native beta-19271 transport. The domain execution adapter is exported by /v2.
 * Wire contracts: @opencode-ai/{protocol,schema}@0.0.0-beta-19271,
 * including prompt-input.js (IDs) versus prompt.js (resolved receipts).
 * No v1 SDK, fabricated parentID, execution attribution, or tool authority.
 */
import { z } from "zod";
import { HeadlessThreadError } from "./errors.ts";
import type { HeadlessFetch } from "./v2-types.ts";

const sessionID = z.string().startsWith("ses_").min(5);
const messageID = z.string().startsWith("msg_").min(5);
const fields = z.record(z.string(), z.unknown());
const time = z.object({ created: z.number(), ran: z.number().optional(), completed: z.number().optional() }).passthrough();
const location = z.object({ directory: z.string().min(1), workspaceID: z.string().optional() }).passthrough();
const model = z.object({ providerID: z.string().min(1), id: z.string().min(1), variant: z.string().min(1).optional() });
const tokens = z.object({ input: z.number(), output: z.number(), reasoning: z.number(), cache: z.object({ read: z.number(), write: z.number() }) });
const nativeError = z.object({ type: z.string(), message: z.string(), status: z.number().int().min(100).max(599).optional() }).passthrough();
const mention = z.object({ start: z.number(), end: z.number(), text: z.string() });
const skillID = z.string().min(1).max(2048).refine((id) => id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id));
/** Deliberately support IDs only; never accept caller-supplied skill bodies or mentions. */
export const nativeV2SkillsSchema = z.array(z.object({ id: skillID }).strict()).max(32)
  .transform((skills) => skills.filter((skill, index) => skills.findIndex((item) => item.id === skill.id) === index));
const resolvedSkills = z.array(z.object({ id: skillID, name: z.string().min(1), text: z.string().optional(), mention: mention.optional() }).passthrough()).max(32);
const prompt = {
  text: z.string(),
  files: z.array(z.object({
    data: z.string(), mime: z.string(),
    source: z.discriminatedUnion("type", [z.object({ type: z.literal("inline") }), z.object({ type: z.literal("uri"), uri: z.string() })]),
    name: z.string().optional(), description: z.string().optional(), mention: mention.optional(),
  }).passthrough()).optional(),
  agents: z.array(z.object({ name: z.string(), mention: mention.optional() }).passthrough()).optional(),
  skills: resolvedSkills.optional(),
};
/** Receipt matching uses frozen IDs, never today's catalog name or content. */
export function nativeV2AttachmentsMatch(value: unknown, skills: Array<{ id: string }>): boolean {
  const parsed = z.object({ files: z.array(z.never()).optional(), agents: z.array(z.never()).optional(), skills: resolvedSkills.optional() }).safeParse(value);
  return parsed.success && (parsed.data.skills?.length ?? 0) === skills.length
    && (parsed.data.skills ?? []).every((skill, index) => skill.id === skills[index]?.id && skill.mention === undefined);
}
const content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("file"), uri: z.string(), mime: z.string(), name: z.string().optional() }).passthrough(),
]);
const toolState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("streaming"), input: z.string() }).passthrough(),
  z.object({ status: z.literal("running"), input: fields, metadata: fields }).passthrough(),
  z.object({ status: z.literal("completed"), input: fields, content: z.array(content).min(1), metadata: fields.optional() }).passthrough(),
  z.object({ status: z.literal("error"), input: fields, error: nativeError, content: z.array(content).min(1).optional(), metadata: fields.optional() }).passthrough(),
]);
const baseMessage = { id: messageID, time, metadata: fields.optional() };
const userMessage = z.object({ ...baseMessage, type: z.literal("user"), ...prompt }).passthrough();
const syntheticMessage = z.object({ ...baseMessage, type: z.literal("synthetic"), text: z.string(), description: z.string().optional() }).passthrough();
const message = z.union([
  userMessage,
  syntheticMessage,
  z.object({
    ...baseMessage, type: z.literal("assistant"), agent: z.string(), model,
    content: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
      z.object({ type: z.literal("reasoning"), text: z.string(), time: time.optional() }).passthrough(),
      z.object({ type: z.literal("tool"), id: z.string(), name: z.string(), state: toolState, time, executed: z.boolean().optional() }).passthrough(),
    ])),
    cost: z.number().optional(), tokens: tokens.optional(), error: nativeError.optional(),
    finish: z.enum(["stop", "length", "tool-calls", "content-filter", "error", "unknown"]).optional(),
    retry: z.object({ attempt: z.number().int().positive(), at: z.number(), error: nativeError }).optional(),
  }).passthrough(),
  z.object({ ...baseMessage, type: z.literal("system"), text: z.string(), description: z.string().optional() }).passthrough(),
  z.object({ ...baseMessage, type: z.literal("agent-switched"), agent: z.string(), previous: z.string().optional() }).passthrough(),
  z.object({ ...baseMessage, type: z.literal("model-switched"), model, previous: model.optional() }).passthrough(),
  z.object({ ...baseMessage, type: z.literal("location-switched"), location }).passthrough(),
  z.object({ ...baseMessage, type: z.literal("skill"), skill: z.string(), name: z.string(), text: z.string() }).passthrough(),
  z.object({
    ...baseMessage, type: z.literal("shell"), shellID: z.string(), command: z.string(),
    status: z.enum(["running", "exited", "timeout", "killed"]), exit: z.number().optional(),
    output: z.object({ output: z.string(), cursor: z.number().int().nonnegative(), size: z.number().int().nonnegative(), truncated: z.boolean() }).optional(),
  }).passthrough(),
  z.object({ ...baseMessage, type: z.literal("compaction") }).passthrough().and(z.discriminatedUnion("status", [
    z.object({ status: z.literal("running"), reason: z.enum(["auto", "manual"]), summary: z.string(), recent: z.string() }).passthrough(),
    z.object({ status: z.literal("completed"), reason: z.enum(["auto", "manual"]), summary: z.string(), recent: z.string(), model: model.optional() }).passthrough(),
    z.object({ status: z.literal("failed"), reason: z.enum(["auto", "manual"]), error: nativeError }).passthrough(),
  ])),
]);
const scopedMessage = z.union([message, z.object({ ...baseMessage, type: z.literal("idle"), outcome: z.enum(["succeeded", "failed", "interrupted"]) }).passthrough()]);
const session = z.object({
  id: sessionID, location, projectID: z.string(), title: z.string().optional(),
  parentID: sessionID.optional(), metadata: fields.optional(),
  agent: z.string().optional(), model: model.optional(), cost: z.number(), tokens,
  time: z.object({ created: z.number(), updated: z.number(), idle: z.number().optional(), archived: z.number().optional() }).passthrough(),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
}).passthrough();
const enqueued = { id: messageID, sessionID, timeCreated: z.number(), delivery: z.enum(["steer", "queue"]) };
const userReceipt = z.object({ ...enqueued, type: z.literal("user"), payload: z.object({ ...prompt, metadata: fields.optional() }).passthrough() }).passthrough();
const syntheticReceipt = z.object({ ...enqueued, type: z.literal("synthetic"), payload: z.object({ text: z.string(), description: z.string().optional(), metadata: fields.optional() }).passthrough() }).passthrough();
const inboxItem = z.discriminatedUnion("type", [
  userReceipt, syntheticReceipt,
  z.object({ ...enqueued, type: z.literal("compaction"), payload: z.object({}).strict() }).passthrough(),
  z.object({ ...enqueued, type: z.literal("move"), payload: z.object({ location, projectID: z.string(), subpath: z.string().optional() }).passthrough() }).passthrough(),
]);
// Published schemas say optional; the pinned beta19086 binary emits null on
// the empty boundary page. Both mean exhausted, never a cursor to follow.
const cursorValue = z.string().min(1).nullish().transform((value) => value ?? undefined);
const historyPage = z.object({ data: z.array(message), cursor: z.object({ previous: cursorValue, next: cursorValue }) });
const inputSchema = z.object({ id: messageID, type: z.enum(["user", "synthetic"]), text: z.string(), skills: nativeV2SkillsSchema.optional(), metadata: fields.optional(), delivery: z.enum(["steer", "queue"]).optional(), resume: z.boolean().optional() }).strict()
  .refine((input) => input.type === "user" || input.skills === undefined, "Synthetic input cannot attach skills.");
const eventSchema = z.object({
  id: z.string(), type: z.string(), created: z.number().optional(), data: fields,
  durable: z.object({ aggregateID: z.string(), seq: z.number().int().nonnegative(), version: z.number().int().positive() }).optional(),
}).passthrough();
const permission = z.object({
  id: z.string().startsWith("per"), sessionID, action: z.string(), resources: z.array(z.string()), save: z.array(z.string()).optional(),
  source: z.object({ type: z.literal("tool"), messageID: z.string(), id: z.string() }).optional(), metadata: fields.optional(),
});
const formOption = z.object({ value: z.string(), label: z.string(), description: z.string().optional() });
const formField = z.object({
  key: z.string(), type: z.enum(["string", "multiselect", "number", "integer", "boolean", "external"]),
  title: z.string().optional(), description: z.string().optional(), options: z.array(formOption).optional(),
  custom: z.boolean().optional(), required: z.boolean().optional(), when: z.array(fields).optional(),
}).passthrough();
const form = z.object({ id: z.string().startsWith("frm_"), sessionID, title: z.string(), metadata: fields.optional(), fields: z.array(formField).min(1) });
const provider = z.object({ id: z.string(), name: z.string(), activation: z.enum(["auto", "enabled", "disabled"]), package: z.string(), integrationID: z.string().optional(), settings: fields.optional() });
// @opencode-ai/schema beta19086 connection.js: env entries intentionally have no ID.
const connection = z.discriminatedUnion("type", [
  z.object({ type: z.literal("credential"), id: z.string().min(1), label: z.string() }),
  z.object({ type: z.literal("env"), name: z.string().min(1) }),
]);
const catalogIdentityID = z.string().max(256).regex(/^[A-Za-z0-9._:@+/-]+$/);
const catalogModel = model.extend({
  upstreamModelId: catalogIdentityID.optional(), modelGroupId: catalogIdentityID.optional(), credentialSetId: catalogIdentityID.optional(),
  name: z.string(), modelID: z.string(), family: z.string().optional(), package: z.string().optional(),
  capabilities: z.object({ tools: z.boolean(), input: z.array(z.string()), output: z.array(z.string()) }),
  variants: z.array(z.object({ id: z.string() })), time: z.object({ released: z.number() }),
  cost: z.array(z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), tier: fields.optional() })),
  status: z.enum(["active", "deprecated", "alpha", "beta"]), enabled: z.boolean(),
  limit: z.object({ context: z.number(), input: z.number().optional(), output: z.number() }),
});
const agentSchema = z.object({ id: z.string(), model: model.optional(), permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "deny", "ask"]) })) });
const skillSchema = z.object({
  id: skillID, name: z.string().min(1), description: z.string().optional(), slash: z.boolean().optional(), autoinvoke: z.boolean().optional(),
  location: z.string().min(1), content: z.string(),
  // Host provenance from cloud-native-skills.ts, not a native ID/path derivation.
  source: z.object({ type: z.literal("openwork-cloud"), uri: z.string().startsWith("skill://").max(1024), scope: z.string().regex(/^[0-9a-f]{64}$/) }).strict().optional(),
});

export type NativeV2Model = z.infer<typeof model>;
export type NativeV2Session = z.infer<typeof session>;
export type NativeV2Message = z.infer<typeof scopedMessage>;
export type NativeV2InboxItem = z.infer<typeof inboxItem>;
export type NativeV2Input = z.infer<typeof inputSchema>;
export type NativeV2Receipt = z.infer<typeof userReceipt> | z.infer<typeof syntheticReceipt>;
export type NativeV2Reconciliation =
  | { state: "queued"; receipt: NativeV2InboxItem }
  | { state: "delivered"; message: NativeV2Message }
  // A missing observation is NOT proof that a timed-out write was rejected.
  | { state: "unobserved"; id: string };
export type NativeV2Admission = Exclude<NativeV2Reconciliation, { state: "unobserved" }> | { state: "accepted"; receipt: NativeV2Receipt };
export type NativeV2Stop = { interrupted: boolean; idle: true; pending: NativeV2InboxItem[] };
export type NativeV2Event = z.infer<typeof eventSchema>;
export type NativeV2Permission = z.infer<typeof permission>;
export type NativeV2Form = z.infer<typeof form>;
export type NativeV2CatalogModel = z.infer<typeof catalogModel>;
export type NativeV2Skill = z.infer<typeof skillSchema>;
export type NativeV2Catalog = {
  providers: z.infer<typeof provider>[];
  models: NativeV2CatalogModel[];
  connectedProviderIds: string[];
};

/** A connected, secret-free projection for Coworker's existing model selectors. */
export function nativeCatalogProviders(catalog: NativeV2Catalog) {
  return catalog.providers.filter((provider) => provider.activation !== "disabled" && catalog.connectedProviderIds.includes(provider.id)).map((provider) => {
    // Coworker needs only the origin to classify local model servers, not auth
    // in URL userinfo, query parameters, or provider settings.
    let origin: string | undefined;
    try {
      const url = new URL(typeof provider.settings?.baseURL === "string" ? provider.settings.baseURL : "");
      if (url.protocol === "http:" || url.protocol === "https:") origin = url.origin;
    } catch { /* No usable endpoint evidence. */ }
    return {
      id: provider.id,
      name: provider.name,
      options: origin ? { baseURL: origin } : {},
      models: Object.fromEntries(catalog.models.filter((model) => model.enabled && model.providerID === provider.id).map((model) => {
        const price = model.cost.find((cost) => !cost.tier);
        const modalities = (values: string[]) => Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((kind) => [kind, values.some((value) => value === kind || value.startsWith(`${kind}/`))]));
        const released = new Date(model.time.released);
        return [model.id, {
          name: model.name, family: model.family,
          ...(model.upstreamModelId ? { upstreamModelId: model.upstreamModelId } : {}),
          ...(model.modelGroupId ? { modelGroupId: model.modelGroupId } : {}),
          ...(model.credentialSetId ? { credentialSetId: model.credentialSetId } : {}),
          variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
          status: model.status,
          release_date: model.time.released > 0 && Number.isFinite(released.getTime()) ? released.toISOString().slice(0, 10) : "",
          ...(price ? { cost: { input: price.input, output: price.output } } : {}),
          api: { npm: model.package ?? provider.package, id: model.modelID }, limit: model.limit,
          capabilities: { toolcall: model.capabilities.tools, reasoning: model.capabilities.output.includes("reasoning"), input: modalities(model.capabilities.input), output: modalities(model.capabilities.output) },
        }];
      })),
    };
  });
}
export type NativeCatalogProvider = ReturnType<typeof nativeCatalogProviders>[number];

export interface NativeV2ClientOptions {
  baseUrl: string;
  workspaceId: string;
  token: string;
  hostToken?: string;
  fetch?: HeadlessFetch;
  signal?: AbortSignal;
  /** Bounds a request and the complete reconciliation/stop operation. Default 15s. */
  requestTimeoutMs?: number;
  admissionTimeoutMs?: number;
  apiContract?: "beta19271" | "native-2";
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function createNativeV2Client(options: NativeV2ClientOptions) {
  const wireHistoryPage = options.apiContract === "native-2" ? historyPage.extend({ data: z.array(scopedMessage) }) : historyPage;
  const inboxTime = z.object({ time: z.object({ created: z.number() }) }).passthrough().transform((item): unknown => ({ ...item, timeCreated: item.time.created }));
  const wireInboxItem = options.apiContract === "native-2" ? inboxTime.pipe(inboxItem) : inboxItem;
  const receipt = z.union([userReceipt, syntheticReceipt]);
  const wireReceipt = options.apiContract === "native-2" ? inboxTime.pipe(receipt) : receipt;
  const url = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Expected an OpenWork server base URL without credentials, query, or fragment.");
  if (!options.workspaceId.trim() || [".", ".."].includes(options.workspaceId) || !options.token.trim()) throw new Error("Workspace and OpenWork client token are required.");
  while (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  const baseUrl = url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
  // Verified in apps/server/src/server.ts:parseWorkspaceOpencodeV2Mount.
  const mount = `/workspace/${encodeURIComponent(options.workspaceId)}/opencode2/api`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = z.number().int().positive().parse(options.requestTimeoutMs ?? 15_000);
  const admissionTimeoutMs = options.admissionTimeoutMs === undefined ? undefined : z.number().int().positive().max(120_000).parse(options.admissionTimeoutMs);
  const attempted = new Set<string>();
  const preparing = new Set<string>();
  const headers = { Authorization: `Bearer ${options.token}`, ...(options.hostToken === undefined ? {} : { "X-OpenWork-Host-Token": options.hostToken }) };
  const bounded = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(timeoutMs), ...[options.signal, signal].filter((value): value is AbortSignal => value !== undefined)]);
  const sessionPath = (id: string) => `/session/${encodeURIComponent(sessionID.parse(id))}`;
  const failure = (code: string, method: string, path: string, message: string, status?: number) => new HeadlessThreadError({ code, method, path: `${mount}${path}`, message, status });

  async function request<T>(method: string, path: string, schema: z.ZodType<T>, signal?: AbortSignal, body?: unknown, status = 200, beforeWrite?: () => void | Promise<void>): Promise<T> {
    let response: Response;
    const requestSignal = bounded(signal);
    requestSignal.throwIfAborted();
    if (beforeWrite) await beforeWrite();
    try {
      response = await fetchImpl(`${baseUrl}${mount}${path}`, {
        method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: requestSignal,
        // Bun otherwise retries reset pooled sockets, including POSTs.
        ...(method === "GET" ? {} : { keepalive: false }),
      });
    } catch {
      throw failure("request_failed", method, path, method === "GET" ? "Native v2 observation failed. Execution status is unavailable." : "Native v2 request failed; a write may have been admitted.");
    }
    if (!response.ok) {
      let publicCode: string | null = null;
      if (response.headers.get("content-type")?.includes("application/json")) {
        const reader = response.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (bytes <= 4096) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              chunks.push(part.value);
            }
            if (bytes <= 4096) {
              const data = new Uint8Array(bytes);
              let offset = 0;
              for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
              const payload: unknown = JSON.parse(new TextDecoder().decode(data));
              if (payload && typeof payload === "object" && !Array.isArray(payload) && "code" in payload
                && typeof payload.code === "string" && /^[a-z][a-z0-9_]{1,79}$/.test(payload.code)) publicCode = payload.code;
            }
          } catch { /* The HTTP status remains the useful error. */ }
          finally { await reader.cancel().catch(() => undefined); }
        }
      } else await response.body?.cancel();
      throw failure("request_failed", method, path,
        `OpenWork returned HTTP ${response.status}${publicCode ? ` (${publicCode})` : ""}.`, response.status);
    }
    try {
      if (response.status !== status) throw new Error("Unexpected status");
      const payload: unknown = status === 204 ? undefined : await response.json();
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw failure("invalid_response", method, path, `Invalid native v2 fields: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}.`, response.status);
      return parsed.data;
    } catch (error) {
      if (error instanceof HeadlessThreadError) throw error;
      throw failure("invalid_response", method, path, "OpenWork returned an invalid native v2 response.", response.status);
    }
  }

  async function getSession(id: string, signal?: AbortSignal): Promise<NativeV2Session> {
    const path = sessionPath(id);
    const result = await request("GET", path, z.object({ data: session }), signal);
    if (result.data.id !== id) throw failure("invalid_response", "GET", path, "Native session identity did not match.");
    return result.data;
  }

  /** Bind explicitly at creation. Persist the chosen ID before calling; never recreate after an uncertain response. */
  async function createSession(input: { id: string; title?: string; model: NativeV2Model; agent: string; metadata?: Record<string, unknown> }, signal?: AbortSignal): Promise<NativeV2Session> {
    const body = z.object({ id: sessionID, title: z.string().optional(), model: model.strict(), agent: z.string().min(1), metadata: fields.optional() }).strict().parse(input);
    const key = `session:${body.id}`;
    let result: NativeV2Session;
    if (attempted.has(key)) result = await getSession(body.id, signal);
    else {
      attempted.add(key);
      // Native create can return an existing ID before applying location. Only
      // the scoped GET checks that the resulting session belongs to this workspace.
      try {
        const created = await request("POST", "/session", z.object({ data: session }), signal, body);
        if (created.data.id !== body.id) throw failure("binding_unconfirmed", "POST", "/session", "Created session identity did not match. Do not recreate it.");
      } catch (error) {
        if (error instanceof HeadlessThreadError && [400, 401, 403, 422].includes(error.status ?? 0)) throw error;
        // The stable ID is reconciled below, never replaced after a lost response.
      }
      result = await getSession(body.id, signal);
    }
    // Native Session.Info canonicalizes an omitted variant to "default".
    if (result.id !== body.id || result.agent !== body.agent || result.model?.id !== body.model.id || result.model?.providerID !== body.model.providerID || (result.model?.variant ?? "default") !== (body.model.variant ?? "default")) {
      throw failure("binding_unconfirmed", "POST", "/session", "Session model/agent binding could not be confirmed. Do not recreate it.");
    }
    return result;
  }

  async function readInbox(id: string, signal?: AbortSignal): Promise<NativeV2InboxItem[]> {
    const path = `${sessionPath(id)}/inbox`;
    const result = await request("GET", path, z.object({ data: z.array(wireInboxItem) }), signal);
    if (result.data.some((item) => item.sessionID !== id) || new Set(result.data.map((item) => item.id)).size !== result.data.length) throw failure("invalid_response", "GET", path, "Inbox identities did not match.");
    return result.data;
  }

  async function readHistoryPage(id: string, input: { cursor?: string; signal?: AbortSignal } = {}) {
    const query = new URLSearchParams({ limit: "200" });
    if (input.cursor !== undefined) query.set("cursor", z.string().min(1).parse(input.cursor));
    else query.set("order", "asc");
    return request("GET", `${sessionPath(id)}/message?${query}`, wireHistoryPage, input.signal);
  }

  /** Read only. Recovery must use this method, never a new admission based on an unobserved result. */
  async function reconcileAdmission(id: string, inputID: string, signal?: AbortSignal): Promise<NativeV2Reconciliation> {
    messageID.parse(inputID);
    signal = bounded(signal);
    const queued = (await readInbox(id, signal)).find((item) => item.id === inputID);
    if (queued) return { state: "queued", receipt: queued };
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await readHistoryPage(id, { cursor, signal });
      for (const item of result.data) {
        if (ids.has(item.id)) throw failure("invalid_response", "GET", `${sessionPath(id)}/message`, "History repeated a native message ID.");
        ids.add(item.id);
      }
      const found = result.data.find((item) => item.id === inputID);
      if (found) return { state: "delivered", message: found };
      cursor = result.cursor.next;
      if (cursor === undefined) {
        const pending = (await readInbox(id, signal)).find((item) => item.id === inputID);
        return pending ? { state: "queued", receipt: pending } : { state: "unobserved", id: inputID };
      }
      if (cursors.has(cursor)) throw failure("invalid_response", "GET", `${sessionPath(id)}/message`, "History repeated a pagination cursor.");
      cursors.add(cursor);
    }
    throw failure("history_limit", "GET", `${sessionPath(id)}/message`, "Reconciliation exceeded 100 pages; admission remains unconfirmed.");
  }

  function matching(observed: NativeV2Admission, input: NativeV2Input, path: string): NativeV2Admission {
    const item = observed.state === "delivered" ? observed.message : observed.receipt;
    const payload = observed.state === "delivered" ? observed.message : observed.receipt.payload;
    if (item.id !== input.id || item.type !== input.type || !("text" in payload) || payload.text !== input.text
      || (input.metadata !== undefined && JSON.stringify(payload.metadata) !== JSON.stringify(input.metadata))
      || !nativeV2AttachmentsMatch(payload, input.skills ?? [])) {
      throw failure("input_conflict", "POST", path, "Native input ID belongs to different content; it will not be resent.");
    }
    return observed;
  }

  /** Exact-content reconciliation only. Unlike admitInput this can never POST. */
  async function reconcileInput(id: string, value: NativeV2Input, signal?: AbortSignal): Promise<NativeV2Reconciliation> {
    const input = inputSchema.parse(value);
    const observed = await reconcileAdmission(id, input.id, signal);
    if (observed.state !== "unobserved") matching(observed, input, sessionPath(id));
    return observed;
  }

  /**
   * First admission only: the owner must persist intent before calling. At most
   * one POST per ID per client, including concurrent calls and uncertain failures.
   * After process restart use reconcileAdmission against the owner's saved IDs.
   * Synthetic input is separate, queued with resume:false; it never starts a turn.
   * Selected skills require live catalog membership and native session permission.
   * This does not atomically pair context with a prompt or set tool policies.
   */
  async function admitInput(id: string, value: NativeV2Input, signal?: AbortSignal, beforeWrite?: () => void | Promise<void>): Promise<NativeV2Admission> {
    const input = inputSchema.parse(value);
    const path = `${sessionPath(id)}/${input.type === "user" ? "prompt" : "synthetic"}`;
    const observed = await reconcileAdmission(id, input.id, signal);
    if (observed.state !== "unobserved") return matching(observed, input, path);
    const key = JSON.stringify([id, input.id]);
    if (attempted.has(key) || preparing.has(key)) throw failure("admission_unknown", "POST", path, "This ID was already submitted or reserved. Reconcile it; do not resend.");
    if (input.skills?.length) await checkSkills(id, input.skills, signal);
    // Permission evaluation is asynchronous; another call may have submitted meanwhile.
    if (attempted.has(key) || preparing.has(key)) throw failure("admission_unknown", "POST", path, "This ID was already submitted or reserved. Reconcile it; do not resend.");
    signal?.throwIfAborted();
    options.signal?.throwIfAborted();
    preparing.add(key);
    try {
      const result = await request("POST", path, z.object({ data: wireReceipt }), signal, {
        id: input.id, text: input.text, delivery: input.delivery ?? "queue", resume: input.resume ?? input.type === "user",
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.skills?.length ? { skills: input.skills } : {}),
      }, 200, async () => {
        await beforeWrite?.();
        attempted.add(key);
      });
      if (result.data.sessionID !== id || result.data.delivery !== (input.delivery ?? "queue")) throw failure("invalid_response", "POST", path, "Admission receipt scope or delivery did not match.");
      return matching({ state: "accepted", receipt: result.data }, input, path);
    } catch (error) {
      if (!attempted.has(key)) throw error;
      if (error instanceof HeadlessThreadError && (error.code === "input_conflict" || [400, 401, 403, 404, 422].includes(error.status ?? 0))) throw error;
      const budget = admissionTimeoutMs ?? timeoutMs;
      const now = options.now ?? Date.now;
      const deadline = now() + budget;
      const observationSignal = AbortSignal.any([AbortSignal.timeout(budget), ...[signal, options.signal].filter((value): value is AbortSignal => value !== undefined)]);
      do {
        if (observationSignal.aborted) break;
        try {
          const reconciled = await reconcileAdmission(id, input.id, observationSignal);
          observationSignal.throwIfAborted();
          if (reconciled.state !== "unobserved") return matching(reconciled, input, path);
        } catch (reconciliationError) {
          if (reconciliationError instanceof HeadlessThreadError && (reconciliationError.code === "input_conflict" || [401, 403, 404].includes(reconciliationError.status ?? 0))) throw reconciliationError;
        }
        if (admissionTimeoutMs === undefined || observationSignal.aborted || now() >= deadline) break;
        const delay = Math.min(500, deadline - now());
        if (options.sleep) await options.sleep(delay, observationSignal);
        else await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); observationSignal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, delay);
          observationSignal.addEventListener("abort", done, { once: true });
        });
      } while (now() < deadline);
      throw failure("admission_unknown", "POST", path, "Native admission could not be confirmed. Keep the ID and reconcile; do not resend.");
    } finally { preparing.delete(key); }
  }

  /** Observed idle is not success, queue cancellation, or native control revocation. */
  async function stop(id: string, signal?: AbortSignal): Promise<NativeV2Stop> {
    signal = bounded(signal);
    const path = sessionPath(id);
    const receipt = await request("POST", `${path}/interrupt?continue=false`, z.object({ interrupted: z.boolean() }), signal);
    await request("POST", `${options.apiContract === "native-2" ? "/experimental" : ""}${path}/wait`, z.undefined(), signal, undefined, 204);
    const pending = await readInbox(id, signal);
    const active = await request("GET", "/session/active", z.object({ data: z.record(sessionID, z.object({ type: z.literal("running") })) }), signal);
    if (Object.hasOwn(active.data, id)) throw failure("stop_unconfirmed", "POST", `${path}/interrupt`, "Native execution is still active after waiting; stop is unconfirmed.");
    return { interrupted: receipt.interrupted, idle: true, pending };
  }

  async function readHistory(id: string, signal?: AbortSignal): Promise<NativeV2Message[]> {
    signal = bounded(signal);
    const result: NativeV2Message[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const next = await readHistoryPage(id, { cursor, signal });
      for (const item of next.data) {
        if (ids.has(item.id)) throw failure("invalid_response", "GET", sessionPath(id), "History repeated a message ID.");
        ids.add(item.id);
        result.push(item);
      }
      cursor = next.cursor.next;
      if (cursor === undefined) return result;
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    throw failure("history_limit", "GET", sessionPath(id), "Native history did not reach its boundary.");
  }

  async function* stream(path: string, signal: AbortSignal): AsyncGenerator<unknown> {
    const response = await fetchImpl(`${baseUrl}${mount}${path}`, { headers: { ...headers, Accept: "text/event-stream" }, redirect: "error", signal });
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel();
      throw failure("invalid_response", "GET", path, "Native event stream unavailable.", response.status);
    }
    const reader = response.body.getReader();
    // A transport may deliver headers yet leave a pending read after abort.
    // Close the reader explicitly so cancelling a quiet event stream settles.
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const decoder = new TextDecoder();
    let buffer = "", data: string[] = [], dataSize = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 4_194_304) throw failure("invalid_response", "GET", path, "Native event exceeded the read bound.");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (line === "") {
            if (data.length) yield JSON.parse(data.join("\n"));
            data = []; dataSize = 0;
          } else if (line.startsWith("data:")) {
            dataSize += line.length;
            if (dataSize > 4_194_304) throw failure("invalid_response", "GET", path, "Native event exceeded the read bound.");
            data.push(line.slice(5).replace(/^ /, ""));
          }
        }
      }
    } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
  }

  async function* events(signal?: AbortSignal): AsyncGenerator<NativeV2Event> {
    const signals = [options.signal, signal].filter((item): item is AbortSignal => item !== undefined);
    for await (const value of stream("/event", AbortSignal.any(signals))) yield eventSchema.parse(value);
  }
  const readActive = async (signal?: AbortSignal) => (await request("GET", "/session/active", z.object({ data: z.record(sessionID, z.object({ type: z.literal("running") })) }), signal)).data;
  async function listSessions(signal?: AbortSignal) {
    signal = bounded(signal);
    const result: NativeV2Session[] = [];
    let path = "/session?limit=200&order=desc";
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const next = await request("GET", path, z.object({ data: z.array(session), cursor: z.object({ next: cursorValue }) }), signal);
      result.push(...next.data);
      if (new Set(result.map((item) => item.id)).size !== result.length) throw failure("invalid_response", "GET", path, "Session listing repeated an identity.");
      if (!next.cursor.next) return result;
      if (cursors.has(next.cursor.next)) break;
      cursors.add(next.cursor.next);
      path = `/session?cursor=${encodeURIComponent(next.cursor.next)}`;
    }
    throw failure("history_limit", "GET", path, "Session listing did not reach its boundary.");
  }
  const renameSession = (id: string, title: string, signal?: AbortSignal) => options.apiContract === "native-2"
    ? request("PATCH", sessionPath(id), z.undefined(), signal, { title }, 204)
    : request("POST", `${sessionPath(id)}/rename`, z.undefined(), signal, { title }, 204);
  const switchModel = (id: string, value: NativeV2Model, signal?: AbortSignal) => request("POST", `${sessionPath(id)}/model`, z.undefined(), signal, { model: model.parse(value) }, 204);
  const switchAgent = (id: string, agent: string, signal?: AbortSignal) => request("POST", `${sessionPath(id)}/agent`, z.undefined(), signal, { agent: z.string().min(1).parse(agent) }, 204);
  const getAgent = async (id: string, signal?: AbortSignal) => (await request("GET", `/agent/${encodeURIComponent(id)}`, z.object({ data: agentSchema }), signal)).data;
  const defaultModel = async (signal?: AbortSignal) => (await request("GET", "/model/default", z.object({ data: catalogModel.nullish() }), signal)).data ?? undefined;
  async function listSkills(signal?: AbortSignal): Promise<NativeV2Skill[]> {
    const { data } = await request("GET", "/skill", z.object({ data: z.array(skillSchema).max(10_000) }), signal);
    if (new Set(data.map((skill) => skill.id)).size !== data.length) throw failure("invalid_response", "GET", "/skill", "Native skill catalog repeated an identity.");
    return data;
  }
  /** Preflight for paired context; admitInput repeats this check at the actual prompt boundary. */
  async function checkSkills(id: string, value: Array<{ id: string }>, signal?: AbortSignal): Promise<void> {
    const skills = nativeV2SkillsSchema.parse(value);
    if (!skills.length) return;
    signal = bounded(signal);
    const path = `${sessionPath(id)}/permission`;
    const catalog = await listSkills(signal);
    if (skills.some((skill) => !catalog.some((item) => item.id === skill.id))) throw failure("skill_unavailable", "GET", "/skill", "A selected native skill is no longer available. Nothing was submitted.");
    const current = await getSession(id, signal);
    if (!current.agent) throw failure("binding_unconfirmed", "POST", path, "The current native agent could not be confirmed.");
    const resources = skills.map((skill) => skill.id);
    // Keep an existing native ask visible. Never approve it or turn it into a grant.
    const pending = await listPermissions(id, signal);
    if (pending.some((item) => item.action === "skill" && item.resources.some((resource) => resources.includes(resource)))) throw failure("skill_permission_required", "POST", path, "Selected skills have a pending native permission request. Nothing was submitted.");
    const result = await request("POST", path, z.object({ data: z.object({ id: z.string().startsWith("per"), effect: z.enum(["allow", "deny", "ask"]) }) }), signal,
      { action: "skill", resources, save: resources, agent: current.agent });
    if (result.data.effect !== "allow") throw failure(result.data.effect === "ask" ? "skill_permission_required" : "skill_denied", "POST", path, "Selected skills were not allowed by native session permission. Nothing was submitted.");
    const confirmed = await getSession(id, signal);
    if (confirmed.agent !== current.agent) throw failure("binding_unconfirmed", "POST", path, "The native agent changed during skill permission evaluation.");
  }
  async function readCatalog(signal?: AbortSignal): Promise<NativeV2Catalog> {
    const [providers, models, integrations] = await Promise.all([
      request("GET", "/provider", z.object({ data: z.array(provider) }), signal),
      request("GET", "/model", z.object({ data: z.array(catalogModel) }), signal),
      request("GET", "/integration", z.object({ data: z.array(z.object({ id: z.string(), connections: z.array(connection) })) }), signal),
    ]);
    const connectedProviderIds = providers.data.filter((item) => item.activation !== "disabled" && (item.activation === "enabled" || integrations.data.some((integration) => integration.id === (item.integrationID ?? item.id) && integration.connections.length > 0))).map((item) => item.id);
    return { providers: providers.data, models: models.data, connectedProviderIds };
  }
  const listPermissions = async (id: string, signal?: AbortSignal) => {
    const data = (await request("GET", `${sessionPath(id)}/permission`, z.object({ data: z.array(permission) }), signal)).data;
    if (data.some((item) => item.sessionID !== id)) throw failure("invalid_response", "GET", sessionPath(id), "Permission scope mismatch.");
    return data;
  };
  const listForms = async (id: string, signal?: AbortSignal) => {
    const data = (await request("GET", `${sessionPath(id)}/form`, z.object({ data: z.array(form) }), signal)).data;
    if (data.some((item) => item.sessionID !== id)) throw failure("invalid_response", "GET", sessionPath(id), "Form scope mismatch.");
    return data;
  };
  async function replyPermission(value: NativeV2Permission, reply: "once" | "always" | "reject", signal?: AbortSignal) {
    const expected = permission.parse(value);
    const path = `${sessionPath(expected.sessionID)}/permission/${encodeURIComponent(expected.id)}`;
    const current = (await request("GET", path, z.object({ data: permission }), signal)).data;
    if (JSON.stringify(current) !== JSON.stringify(expected) || (reply === "always" && !current.save?.length)) throw failure("stale_request", "POST", path, "Permission changed or cannot be saved. Read it again.");
    const decision = z.enum(["once", "always", "reject"]).parse(reply);
    return request("POST", `${path}/reply`, z.undefined(), signal, options.apiContract === "native-2" ? { decision } : { reply: decision }, 204);
  }
  async function replyForm(value: NativeV2Form, answer: Record<string, string | string[] | number | boolean> | null, signal?: AbortSignal) {
    const expected = form.parse(value);
    const path = `${sessionPath(expected.sessionID)}/form/${encodeURIComponent(expected.id)}`;
    const current = (await request("GET", path, z.object({ data: form }), signal)).data;
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw failure("stale_request", "POST", path, "Form changed. Read it again.");
    return request("POST", `${path}/${answer === null ? "cancel" : "reply"}`, z.undefined(), signal, answer === null ? undefined : { answer }, 204);
  }
  const cancelInput = (id: string, inputID: string, signal?: AbortSignal) => request("DELETE", `${sessionPath(id)}/inbox/${encodeURIComponent(messageID.parse(inputID))}`, z.undefined(), signal, undefined, 204);
  return { createSession, getSession, readInbox, readHistoryPage, readHistory, reconcileAdmission, reconcileInput, admitInput, stop, cancelInput, events, readActive, listSessions, renameSession, switchModel, switchAgent, getAgent, defaultModel, readCatalog, listSkills, checkSkills, listPermissions, listForms, replyPermission, replyForm };
}

export type NativeV2Client = ReturnType<typeof createNativeV2Client>;
