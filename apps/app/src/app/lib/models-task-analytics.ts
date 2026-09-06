import { z } from "zod";
import { modelsAnalyticsEventSchema, modelsAnalyticsSettingsSchema, type ModelsAnalyticsEvent } from "@openwork-ee/telemetry-contracts";
import { readDenSettings, resolveDenBaseUrls } from "./den";
import { desktopFetchViaMain } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";

const messageSchema = z.object({
  id: z.string(), sessionID: z.string(), parentID: z.string(), role: z.literal("assistant"),
  providerID: z.literal("openwork"), summary: z.boolean().optional(), finish: z.string().optional(),
  time: z.object({ created: z.number(), completed: z.number().optional() }),
  error: z.object({ name: z.string() }).optional(),
});
const toolSchema = z.object({
  id: z.string(), sessionID: z.string(), messageID: z.string(), callID: z.string(), type: z.literal("tool"), tool: z.string(),
  state: z.object({
    status: z.enum(["completed", "error"]),
    time: z.object({ start: z.number(), end: z.number() }),
    // Pick only capability identifiers. Tool arguments/results never leave the device.
    input: z.object({ name: z.string().optional() }),
    metadata: z.object({ skillVersion: z.string().optional(), mcp: z.string().optional() }).optional(),
  }),
});
type Task = { sessionId: string; taskId: string; startedAt: number };
type Pending = { event: ModelsAnalyticsEvent; expiresAt: number; consentedAt: string };

let identity = "";
let allowedUntil = 0;
let allowed = false;
let consentedAt: string | null = null;
let checking: Promise<boolean> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let lastCheckedTask = "";
const tasks = new Map<string, Task>();
const messages = new Map<string, Task>();
let pending: Pending[] = [];

function context() {
  const settings = readDenSettings();
  if (!settings.authToken || !settings.activeOrgId) return null;
  const base = resolveDenBaseUrls(settings).apiBaseUrl;
  return { identity: JSON.stringify([base, settings.activeOrgId, settings.authToken]), base, token: settings.authToken, orgId: settings.activeOrgId };
}

async function request(ctx: NonNullable<ReturnType<typeof context>>, path: string, init?: RequestInit) {
  const url = `${ctx.base}/v1/inference/analytics/${path}`;
  const fetcher = isDesktopRuntime() ? desktopFetchViaMain : globalThis.fetch;
  return fetcher(url, { ...init, signal: AbortSignal.timeout(5_000), headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${ctx.token}`, "x-openwork-org-id": ctx.orgId,
  } });
}

function schedule() {
  if (timer || !pending.length) return;
  timer = setTimeout(() => { timer = null; void flush(); }, 5_000);
}

async function flush() {
  if (flushing) return;
  const ctx = context();
  if (!ctx || ctx.identity !== identity) { pending = []; return; }
  flushing = true;
  const batch = pending.splice(0, 50).filter((item) => item.expiresAt > Date.now());
  try {
    if (!batch.length) return;
    // Recheck consent at the upload boundary. A cached allowance must not send
    // metadata after opt-out, or backfill it into a later consent period.
    const settingsResponse = await request(ctx, "settings");
    const settings = modelsAnalyticsSettingsSchema.safeParse(await settingsResponse.json());
    if (ctx.identity !== identity) return;
    allowed = settingsResponse.ok && settings.success && settings.data.enabled;
    consentedAt = allowed && settings.success ? settings.data.consentedAt : null;
    allowedUntil = Date.now() + 30_000;
    if (!allowed || !consentedAt) { pending = []; return; }
    const consented = batch.filter((item) => item.consentedAt === consentedAt);
    if (!consented.length) return;
    const response = await request(ctx, "events", { method: "POST", body: JSON.stringify({ events: consented.map((item) => item.event) }) });
    if (ctx.identity !== identity) return;
    if (response.status === 204 || response.status === 403 || response.status === 401) {
      pending = []; allowed = false; allowedUntil = 0; return;
    }
    const parsed = z.object({ acceptedIds: z.array(z.string()) }).safeParse(await response.json());
    if (response.ok && parsed.success) pending.push(...consented.filter((item) => !parsed.data.acceptedIds.includes(item.event.id)));
    else if (response.status >= 500) pending.push(...consented);
  } catch { if (ctx.identity === identity) pending.push(...batch); }
  finally { flushing = false; pending = pending.slice(-500); schedule(); }
}

function enqueue(event: ModelsAnalyticsEvent) {
  if (!consentedAt) return;
  if (!modelsAnalyticsEventSchema.safeParse(event).success) return;
  if (pending.some((item) => item.event.id === event.id)) return;
  pending.push({ event, expiresAt: Date.now() + 120_000, consentedAt });
  pending = pending.slice(-500);
  schedule();
}

async function observe(workspaceId: string, event: { type: string; properties?: unknown }) {
  const ctx = context();
  const nextIdentity = ctx?.identity ?? "";
  if (identity !== nextIdentity) {
    identity = nextIdentity; allowedUntil = 0; allowed = false; consentedAt = null; checking = null;
    tasks.clear(); messages.clear(); pending = [];
    lastCheckedTask = "";
  }
  if (!ctx) return;
  if (!allowed && event.type === "message.updated") {
    const info = z.object({ info: messageSchema }).safeParse(event.properties);
    if (info.success && lastCheckedTask !== info.data.info.parentID) {
      lastCheckedTask = info.data.info.parentID;
      allowedUntil = 0;
    }
  }
  if (Date.now() >= allowedUntil) {
    checking ??= request(ctx, "settings").then(async (response) => {
      const parsed = modelsAnalyticsSettingsSchema.safeParse(await response.json());
      if (identity !== ctx.identity) return false;
      allowed = response.ok && parsed.success && parsed.data.enabled;
      consentedAt = allowed && parsed.success ? parsed.data.consentedAt : null;
      allowedUntil = Date.now() + 30_000;
      return allowed;
    }).catch(() => {
      if (identity === ctx.identity) { allowed = false; allowedUntil = Date.now() + 30_000; }
      return false;
    }).finally(() => { if (identity === ctx.identity) checking = null; });
    if (!await checking) return;
  }
  if (!allowed || identity !== ctx.identity) return;
  const props = z.object({ info: z.unknown().optional(), part: z.unknown().optional() }).safeParse(event.properties);
  if (!props.success) return;
  if (event.type === "message.updated") {
    const parsed = messageSchema.safeParse(props.data.info);
    if (!parsed.success || parsed.data.summary) return;
    const info = parsed.data;
    const taskKey = `${workspaceId}:${info.sessionID}:${info.parentID}`;
    const task = tasks.get(taskKey) ?? { sessionId: info.sessionID, taskId: info.parentID, startedAt: info.time.created };
    if (!tasks.has(taskKey)) {
      tasks.set(taskKey, task);
      enqueue({ id: `${task.taskId}:started`, type: "task.started", timestamp: new Date(task.startedAt).toISOString(), sessionId: task.sessionId, taskId: task.taskId });
    }
    messages.set(`${workspaceId}:${info.id}`, task);
    if (info.time.completed && (info.error || info.finish && info.finish !== "tool-calls")) {
      const status = info.error?.name === "MessageAbortedError" ? "cancelled" : info.error ? "failed" : "completed";
      enqueue({ id: `${task.taskId}:${status}`, type: `task.${status}`, status, sessionId: task.sessionId, taskId: task.taskId,
        timestamp: new Date(info.time.completed).toISOString(), durationMs: Math.max(0, info.time.completed - task.startedAt) });
    }
    if (tasks.size > 500) tasks.delete(tasks.keys().next().value!);
    if (messages.size > 2_000) messages.delete(messages.keys().next().value!);
  }
  if (event.type === "message.part.updated") {
    const parsed = toolSchema.safeParse(props.data.part);
    if (!parsed.success) return;
    const part = parsed.data;
    const task = messages.get(`${workspaceId}:${part.messageID}`);
    if (!task || task.sessionId !== part.sessionID) return;
    const name = part.state.input.name;
    const cloudSkill = part.tool === "openwork-cloud_execute_capability" && name?.startsWith("plugin:");
    const skill = part.state.status === "completed" && (part.tool === "skill" || cloudSkill) ? name : undefined;
    enqueue({ id: part.id, callId: part.callID, type: skill ? "skill.loaded" : "tool.executed",
      timestamp: new Date(part.state.time.end).toISOString(), sessionId: task.sessionId, taskId: task.taskId,
      tool: part.tool, ...(skill ? { skill, skillVersion: part.state.metadata?.skillVersion } : {}),
      mcp: part.tool.startsWith("openwork-cloud_") ? "openwork-cloud" : part.state.metadata?.mcp,
      durationMs: Math.max(0, part.state.time.end - part.state.time.start), status: part.state.status === "completed" ? "completed" : "failed",
    });
  }
}

/** Optional, bounded reporting from live runtime events. Never blocks chat. */
export function observeModelsTaskEvent(workspaceId: string, event: { type: string; properties?: unknown }) {
  if (event.type !== "message.updated" && event.type !== "message.part.updated") return;
  void observe(workspaceId, event).catch(() => {});
}
