/**
 * Open Coworker threads are native OpenWork sessions in the coworker's workspace,
 * driven through the shared `@openwork/headless-threads` client against the
 * embedded server's workspace-scoped engine proxy. Nothing here invents a
 * conversation type: a thread created in Open Coworker opens in OpenWork.
 */
import {
  createHeadlessThreadClientV2,
  createNativeV2Client,
  nativeV2PartId,
  type HeadlessThreadClient,
  type HeadlessThreadStatus as SessionStatus,
  type NativeV2ClientOptions,
  type NativeV2Form,
  type NativeV2Permission,
  type NativeV2Skill,
} from "@openwork/headless-threads/v2";
import { z } from "zod";
import { RECENT_WORK_LIMIT } from "./activity-summary.ts";
import { readCloudProviderSyncStatus, type CloudProviderSyncStatus, type DenSession } from "./den.ts";
import type { CoworkerSummary, ExpectedWorkspaceReadiness, RuntimeInfo } from "./bridge.ts";
import { resolveDiscussionModel } from "./model-choice.ts";
import type { ModelDefaults } from "./model-defaults.ts";
import { discussionIds, discussionIdsForCoworker } from "./discussions.ts";
import { coworkerAgent } from "./coworker-agents.ts";
import { coworkerSessionAccess, sessionRouting } from "./session-routing.ts";
import type { StreamEvent } from "./live-stream.ts";
import { workerNameFromTitle } from "./workers.ts";
import { PROGRESS_LIMITS } from "./progress-config.ts";
import { modelCatalogIdentity, normalizeModelIntelligence, preferredRoleModel, type ModelCatalogIdentity, type ModelIntelligence } from "./model-intelligence.ts";

export type ThreadListItem = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus["type"];
  /** While retrying: when the engine will try again and what stopped it, in the provider's words. */
  retry?: { next: number; message: string };
};

/** Keep the coworker's discussions out of outcome-driven assignment lists. */
export function assignmentThreads<T extends { id: string }>(threads: T[], discussions?: string | Iterable<string>): T[] {
  const excluded = new Set(
    (typeof discussions === "string" ? [discussions] : [...(discussions ?? [])]).map((id) => id.trim()).filter(Boolean),
  );
  return excluded.size === 0 ? threads : threads.filter((thread) => !excluded.has(thread.id));
}

/** One finished piece of meaningful work for the Recent activity list. */
export type RecentWork = {
  id: string;
  title: string;
  kind: "assignment" | "responsibility";
  /** Thread outcomes are not recorded, so a finished assignment is "finished"; responsibility runs carry their result. */
  outcome: "finished" | "succeeded" | "failed";
  finishedAt: number;
  threadId?: string;
  /** Failure reason, when the run recorded one. */
  error?: string;
};

export type CoworkerActivity = {
  /** `starting`: the workspace is not answering yet after the AI service (re)started; `offline`: it still is not. */
  state: "idle" | "ready" | "working" | "retrying" | "attention" | "recent" | "starting" | "offline";
  label: string;
  detail: string;
  /** For `retrying`: set when the engine has pushed its retry far out, so the model is effectively unavailable. */
  reason?: string;
  /** One line the header, the rail, and Activity share when a turn needs words (still working, retrying, failed, stopped). */
  summary?: string;
  updatedAt: number;
  /** Thread the current state refers to, when there is one to open. */
  threadId?: string;
  last?: {
    title: string;
    updatedAt: number;
    threadId?: string;
  };
  /** The next scheduled responsibility run, when one is due. */
  next?: { name: string; at: number };
  /** Finished assignments, newest first, excluding whatever is active now. */
  recent?: RecentWork[];
  /** Workers with a turn in flight; `subject` says `detail` names one of them rather than the coworker's own work. */
  workers?: { running: number; subject: boolean };
};

/** Pure display projection input, not an SDK client or a connectivity probe. */
type ProviderListResponse = {
  connected: string[];
  default: Record<string, string>;
  all: Array<{ id: string; name: string; source?: string; options?: Record<string, unknown>; models: Record<string, ModelCatalogIdentity & {
    name?: string; family?: string; variants?: Record<string, unknown>; status?: string; release_date?: string;
    cost?: { input: number; output: number }; api?: { npm?: string; id?: string };
    limit?: { context: number; input?: number; output: number };
    capabilities?: { toolcall?: boolean; reasoning?: boolean; input?: Record<string, boolean>; output?: Record<string, boolean> };
  }> }>;
};

/**
 * Where a connected provider comes from: `cloud` providers were materialized
 * into this engine from the signed-in OpenWork account (organization access,
 * Den-backed inference); `local` providers were configured on this Mac.
 */
export type ModelSource = "cloud" | "local";

/**
 * What stands behind a model, in the order a coworker should prefer when
 * nobody chose: the OpenWork account, a subscription or key on this Mac, a
 * model server running on this Mac, and last OpenWork's free model that needs
 * no account. OpenCode's own catalog (`opencode`) is a tier of its own: it
 * stays selectable in settings and for testing, but the app never promotes it
 * or picks it by itself.
 */
export type ModelTier = "cloud" | "key" | "local-server" | "free" | "opencode";

/** The tiers the app may choose from on its own; `opencode` is deliberately absent. */
export const MODEL_TIER_ORDER: readonly ModelTier[] = ["cloud", "key", "local-server", "free"];

/**
 * OpenWork's free model for people without an account. The engine reports it
 * as its own provider once the free service is connected; until that service
 * is released the provider is absent and the app says the model is not
 * available yet. The ids match the desktop's free-access contract (provider
 * `openwork-free`, standard Luna) so both apps read the same catalog entry.
 */
export const OPENWORK_FREE_PROVIDER_ID = "openwork-free";
export const OPENWORK_FREE_MODEL_ID = "openai/gpt-5.6-luna";
export const OPENWORK_FREE_MODEL_LABEL = "Luna";

/** The engine's own catalog provider: selectable, never recommended. */
export const OPENCODE_PROVIDER_ID = "opencode";

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost"
    || host === "::1"
    || host.endsWith(".local")
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host === "0.0.0.0";
}

/** A provider whose address is on this machine or the local network serves models locally. */
export function isLocalServerProvider(provider: { id: string; options?: Record<string, unknown> }): boolean {
  const baseURL = provider.options?.baseURL;
  if (typeof baseURL !== "string" || !baseURL.trim()) return false;
  try {
    return isPrivateHost(new URL(baseURL).hostname);
  } catch {
    return false;
  }
}

export function modelTier(provider: { id: string; options?: Record<string, unknown> }, source: ModelSource): ModelTier {
  if (provider.id === OPENWORK_FREE_PROVIDER_ID) return "free";
  if (source === "cloud") return "cloud";
  if (provider.id === OPENCODE_PROVIDER_ID) return "opencode";
  return isLocalServerProvider(provider) ? "local-server" : "key";
}

export type EngineModelOption = ModelCatalogIdentity & {
  /** "providerId/modelId" */
  id: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  label: string;
  description: string;
  family: string;
  variants: string[];
  isProviderDefault: boolean;
  source: ModelSource;
  tier: ModelTier;
  /** Coworkers work through tools (files, MCP); a model without tool calls cannot do the job. */
  toolCall: boolean;
  reasoning: boolean;
  /** Catalog status as the provider reports it; deprecated models are never recommended. */
  status: string;
  /** ISO date when known; newer models are preferred among equals. */
  releaseDate: string;
  /** Per-million-token prices; legacy zero defaults are only trusted when knownPrice is true. */
  cost: { input: number; output: number };
  /** Both prices were explicitly reported as finite, non-negative numbers (including free 0/0). */
  knownPrice?: boolean;
  /** Raw catalog facts for automatic selection, separate from permissive display defaults. */
  intelligence?: ModelIntelligence;
  /** Separate fail-closed projection: legacy cost/reasoning defaults are NOT evidence. */
  progressEligibility?: {
    transport: "openai" | "openai-compatible" | null;
    knownPrice: boolean;
    nonReasoning: boolean;
    text: boolean;
    active: boolean;
  };
};

export type ProgressModelOption = Pick<EngineModelOption, "id" | "label" | "cost">;
export function eligibleProgressModels(catalog: Pick<EngineModelCatalog, "models" | "connectedProviderIds">): EngineModelOption[] {
  return catalog.models.filter((model) => {
    const safe = model.progressEligibility;
    return catalog.connectedProviderIds.includes(model.providerId) && safe?.transport && safe.knownPrice && safe.nonReasoning && safe.text && safe.active
      // Native catalogs can synthesize 0/0 when custom-provider pricing is
      // omitted. Do not present that absence as a confirmed free summary model.
      && model.cost.input > 0 && model.cost.output > 0
      && model.cost.input <= PROGRESS_LIMITS.maxInputPrice && model.cost.output <= PROGRESS_LIMITS.maxOutputPrice;
  });
}

export type EngineModelCatalog = {
  models: EngineModelOption[];
  connectedProviderIds: string[];
  /** Account provider sync state; null when the embedded server did not report it. */
  cloud: CloudProviderSyncStatus | null;
};

/** Engine provider keys owned by the OpenWork account sync (`lpr_*` records and the hosted `openwork` provider). */
export function isCloudManagedProviderId(providerId: string): boolean {
  return /^(?:lpr|ipr)_/i.test(providerId) || providerId.trim() === "openwork";
}

export function modelSourceLabel(source: ModelSource): string {
  return source === "cloud" ? "OpenWork Cloud" : "This Mac";
}

/**
 * Where a model comes from, as a person reads it: the account, OpenWork's free
 * model, OpenCode's own catalog, or something configured on this Mac.
 */
export function modelOriginLabel(model: Pick<EngineModelOption, "source" | "tier">): string {
  if (model.tier === "free") return "OpenWork · free";
  if (model.tier === "opencode") return "OpenCode";
  return modelSourceLabel(model.source);
}

const VARIANT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

function sortedVariants(variants: Record<string, unknown> | undefined): string[] {
  return Object.keys(variants ?? {}).sort((left, right) => {
    const leftIndex = VARIANT_ORDER.indexOf(left);
    const rightIndex = VARIANT_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

/** A retry the engine scheduled this long ago and never moved on from is over, not pending. */
export const STALE_RETRY_MS = 60_000;
/** A retry this far in the future is not "trying again" from the person's point of view; the model is unavailable. */
export const FAR_RETRY_MS = 5 * 60_000;

function retryOf(status: SessionStatus | undefined): { retry?: { next: number; message: string } } {
  if (!status || status.type !== "retry") return {};
  return { retry: { next: status.next, message: status.message } };
}

/**
 * A retry the engine has pushed far out (the free tier's daily usage, a long provider
 * backoff) is a stall: the person should hear that the model is unavailable and be able to
 * choose another one, not watch "Retrying" for hours. Returns the reason in plain words.
 */
export function stalledRetry(retry: { next: number; message: string; attempt?: number; reason?: string | null } | undefined, now = Date.now()): string | null {
  if (!retry) return null;
  // Some engines keep retrying an exhausted free allowance indefinitely with a
  // short Retry-After. A few attempts may clear a transient limit; a sustained
  // named limit needs a choice, not an endless loop that also holds Next.
  if (retry.reason === "free_tier_limit" && (retry.attempt ?? 0) >= 3) {
    return `${retry.message.trim() || "The free model's shared usage limit was reached."} (free_tier_limit)`;
  }
  if (!Number.isFinite(retry.next) || retry.next - now <= FAR_RETRY_MS) return null;
  const reason = retry.message.trim().replace(/[.\s]+$/, "");
  return reason || "The AI provider is not answering";
}

/**
 * The engine reports each session as idle, busy, or retrying (with the time of the next
 * attempt). A retry whose next attempt is long past is stale — the attempt already happened
 * and the reply landed, or the run ended — so it reads as idle rather than keeping a finished
 * coworker "Retrying".
 */
export function threadStatusOf(status: { type: SessionStatus["type"]; next?: number; attempt?: number; message?: string; reason?: string | null } | undefined, now = Date.now()): SessionStatus["type"] {
  if (!status) return "idle";
  if (status.type === "retry" && typeof status.next === "number" && Number.isFinite(status.next) && now - status.next > STALE_RETRY_MS) return "idle";
  return status.type;
}

export function connectedModelCatalog(
  value: ProviderListResponse,
  cloud: CloudProviderSyncStatus | null = null,
  now = Date.now(),
): EngineModelCatalog {
  const connected = new Set(value.connected ?? []);
  const cloudProviderIds = new Set(cloud?.providers.map((provider) => provider.providerId) ?? []);
  const accountDisconnected = cloud?.hasSession === false;
  const providers = (value.all ?? []).filter(
    (provider) =>
      connected.has(provider.id) &&
      !(accountDisconnected && isCloudManagedProviderId(provider.id)) &&
      (provider.source !== "custom" || provider.id === "opencode" || Object.keys(provider.models ?? {}).length > 0),
  );
  const models = providers.flatMap((provider) =>
    Object.entries(provider.models ?? {}).map(([modelId, model]) => {
      const intelligence = normalizeModelIntelligence(model, provider.id, now);
      const providerLabel = provider.name?.trim() || provider.id;
      const modelLabel = model.name?.trim() || modelId;
      const source: ModelSource =
        cloudProviderIds.has(provider.id) || isCloudManagedProviderId(provider.id) ? "cloud" : "local";
      const knownPrice = typeof model.cost?.input === "number" && Number.isFinite(model.cost.input) && model.cost.input >= 0
        && typeof model.cost?.output === "number" && Number.isFinite(model.cost.output) && model.cost.output >= 0;
      return {
        ...modelCatalogIdentity(model),
        id: `${provider.id}/${modelId}`,
        providerId: provider.id,
        providerLabel,
        modelId,
        modelLabel,
        label: `${providerLabel} · ${modelLabel}`,
        description: model.family?.trim() || modelId,
        family: model.family?.trim() || "",
        variants: sortedVariants(model.variants),
        isProviderDefault: value.default?.[provider.id] === modelId,
        source,
        tier: modelTier(provider, source),
        // Older catalogs omit capabilities; treat unknown as capable rather than hiding a usable model.
        toolCall: model.capabilities?.toolcall ?? true,
        reasoning: model.capabilities?.reasoning ?? false,
        status: model.status ?? "active",
        releaseDate: model.release_date ?? "",
        cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
        knownPrice,
        intelligence,
        progressEligibility: {
          transport: ["@ai-sdk/openai", "@opencode-ai/ai/providers/openai"].includes(model.api?.npm ?? "") ? "openai" : ["@ai-sdk/openai-compatible", "@opencode-ai/ai/providers/openai-compatible"].includes(model.api?.npm ?? "") ? "openai-compatible" : null,
          knownPrice,
          nonReasoning: model.capabilities?.reasoning === false,
          text: model.capabilities?.input?.text === true && model.capabilities?.output?.text === true,
          active: model.status === "active",
        } satisfies NonNullable<EngineModelOption["progressEligibility"]>,
      };
    }),
  );
  // Account providers first: they are what "Continue with OpenWork" promised.
  // OpenCode's own catalog last: listed, never promoted.
  models.sort((left, right) =>
    Number(right.source === "cloud") - Number(left.source === "cloud") ||
    Number(left.tier === "opencode") - Number(right.tier === "opencode") ||
    left.providerLabel.localeCompare(right.providerLabel) ||
    Number(right.isProviderDefault) - Number(left.isProviderDefault) ||
    left.modelLabel.localeCompare(right.modelLabel),
  );
  return { models, connectedProviderIds: providers.map((provider) => provider.id), cloud };
}

/**
 * The model a coworker should start on when nobody chose one: a connected,
 * tool-capable, non-deprecated model from the best tier available — the
 * OpenWork account, then a subscription or key on this Mac, then a local model
 * server, and only then OpenWork's free model — preferring the provider's own
 * default, then the newest release. OpenCode's own catalog is never
 * recommended: a person can still choose it in settings. Returns null when no
 * connected model in those tiers can use tools, so the caller can say so
 * instead of picking something that would fail. Coworkers that chose a model
 * keep it; this only fills a blank.
 */
export function recommendModel(
  catalog: Pick<EngineModelCatalog, "models">,
  options: { exclude?: string | readonly string[] } = {},
): EngineModelOption | null {
  const excluded = new Set(typeof options.exclude === "string" ? [options.exclude] : options.exclude ?? []);
  const preferred = preferredRoleModel(catalog, "conversation", { exclude: [...excluded] });
  if (preferred) return preferred;
  const candidates = catalog.models.filter(
    (model) => model.providerId !== "opencode" && model.toolCall && model.status !== "deprecated" && !excluded.has(model.id),
  );
  const bestTier = MODEL_TIER_ORDER.find((tier) => candidates.some((model) => model.tier === tier));
  const pool = bestTier ? candidates.filter((model) => model.tier === bestTier) : [];
  // Coworkers do multi-step tool work, so among provider defaults a reasoning
  // model beats a chat alias; then the newest release.
  return [...pool].sort((left, right) =>
    Number(right.isProviderDefault) - Number(left.isProviderDefault)
    || Number(right.reasoning) - Number(left.reasoning)
    || Number(right.status === "active") - Number(left.status === "active")
    || right.releaseDate.localeCompare(left.releaseDate)
    || left.label.localeCompare(right.label),
  )[0] ?? null;
}

/** Parse a coworker's persisted "providerId/modelId" preference. */
export function parseModelPreference(value: string): { providerId: string; modelId: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return { providerId: trimmed.slice(0, separator), modelId: trimmed.slice(separator + 1) };
}

/**
 * A native tool permission holding a turn. The legacy protocol discriminator is
 * retained for persisted UI records, but only a fresh native receipt can reply.
 */
export type PendingPermission = {
  id: string;
  sessionID: string;
  tool?: { messageID: string; callID: string };
  protocol: "legacy" | "v2";
  /** Legacy `permission` or v2 `action`, e.g. `bash`, `edit`, `external_directory`. */
  action: string;
  /** Legacy `patterns` or v2 `resources`: paths, commands, or URLs the request covers. */
  resources: string[];
  /** Whether "always allow" is offered for this request. */
  canAlways: boolean;
  /** Exact native receipt. Never resolve a control by ID alone or a different session. */
  native?: NativeV2Permission;
};

export type PendingQuestionItem = {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiple: boolean;
  custom: boolean;
};

export type PendingQuestion = {
  id: string;
  sessionID: string;
  tool?: { messageID: string; callID: string };
  questions: PendingQuestionItem[];
  native?: NativeV2Form;
};

export type PendingInteractions = {
  permissions: PendingPermission[];
  questions: PendingQuestion[];
};

export type PermissionReply = "once" | "always" | "reject";

const ACTION_LABELS: Record<string, string> = {
  external_directory: "work outside its home folder",
  bash: "run a command",
  shell: "run a command",
  edit: "change files",
  write: "write files",
  read: "read files",
  webfetch: "fetch a web page",
  websearch: "search the web",
  task: "start a sub-task",
  subagent: "start a sub-task",
};

/** Plain-language summary of what a permission request asks for. */
export function describePermission(permission: Pick<PendingPermission, "action" | "resources">): string {
  const base = ACTION_LABELS[permission.action] ?? ACTION_LABELS[permission.action.split(".").pop() ?? ""] ?? permission.action;
  const target = permission.resources[0];
  if (!target) return base;
  const more = permission.resources.length > 1 ? ` (+${permission.resources.length - 1} more)` : "";
  return `${base}: ${target}${more}`;
}

/** One short line for the rail when a thread is waiting on a person. */
export function describeInteractions(pending: PendingInteractions): string {
  const permission = pending.permissions[0];
  if (permission) return `Wants to ${describePermission(permission)}`;
  const question = pending.questions[0]?.questions[0];
  if (question) return question.header || question.question;
  return "";
}

export function hasPendingInteractions(pending: PendingInteractions): boolean {
  return pending.permissions.length > 0 || pending.questions.length > 0;
}

export type CoworkerThreads = {
  client: HeadlessThreadClient;
  prepare: (signal: AbortSignal, selection?: { coworker: Parameters<typeof resolveDiscussionModel>[1]; defaults: ModelDefaults; requestText?: string }) => Promise<void>;
  /** Assignment threads only; discussions are excluded. */
  listThreads: () => Promise<ThreadListItem[]>;
  /** Every top-level thread in the workspace, discussions included, newest first. */
  listAllThreads: (includeLegacy?: boolean) => Promise<ThreadListItem[]>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  listModelCatalog: (signal?: AbortSignal) => Promise<EngineModelCatalog>;
  listModels: () => Promise<EngineModelOption[]>;
  listSkills: (signal?: AbortSignal) => Promise<NativeV2Skill[]>;
  readActivity: () => Promise<CoworkerActivity>;
  /** Pending permissions and questions across the coworker's threads. */
  listPendingInteractions: (signal?: AbortSignal) => Promise<PendingInteractions>;
  /** Pending permissions and questions for one thread, including v2 session-scoped requests. */
  listThreadInteractions: (threadId: string, signal?: AbortSignal) => Promise<PendingInteractions>;
  replyPermission: (permission: PendingPermission, reply: PermissionReply, signal?: AbortSignal) => Promise<void>;
  replyQuestion: (question: PendingQuestion, answers: string[][], signal?: AbortSignal) => Promise<void>;
  rejectQuestion: (question: PendingQuestion, signal?: AbortSignal) => Promise<void>;
  /**
   * Follow the engine's events. `onEvent` fires for anything worth a re-read;
   * `onStream`, when given, also receives the words of a reply as they arrive
   * (the engine writes a text or reasoning part only once it has ended).
   */
  subscribe: (onEvent: () => void, onStream?: (event: StreamEvent) => void, onConfigurationChange?: () => void) => () => void;
};

function normalizeV2Permission(value: NativeV2Permission): PendingPermission {
  return {
    id: value.id,
    sessionID: value.sessionID,
    protocol: "v2",
    tool: value.source ? { messageID: value.source.messageID, callID: value.source.id } : undefined,
    action: value.action,
    resources: value.resources,
    canAlways: (value.save?.length ?? 0) > 0,
    native: value,
  };
}

/**
 * Native forms the question card can show and answer. Web search asks once which
 * provider it may use; unanswered, the search is cancelled after a minute.
 */
const QUESTION_FORM_KINDS = new Set(["question", "websearch.provider"]);

export function normalizeQuestion(value: NativeV2Form): PendingQuestion {
  if (!QUESTION_FORM_KINDS.has(String(value.metadata?.kind)) || value.fields.some((field) => !["string", "multiselect"].includes(field.type) || field.when?.length)) {
    throw new Error("This native form cannot be represented by the question controls. It has not been answered or dismissed.");
  }
  const tool = z.object({ messageID: z.string(), id: z.string() }).safeParse(value.metadata?.tool);
  return {
    id: value.id,
    sessionID: value.sessionID,
    tool: tool.success ? { messageID: tool.data.messageID, callID: tool.data.id } : undefined,
    native: value,
    questions: value.fields.map((field) => ({
      header: field.title ?? "",
      question: field.description ?? field.title ?? "",
      options: (field.options ?? []).map((option) => ({ label: option.label, description: option.description ?? "" })),
      multiple: field.type === "multiselect",
      custom: field.custom === true || !field.options?.length,
    })),
  };
}

/** How long message events are gathered before one refresh answers them all. */
export const EVENT_REFRESH_WINDOW_MS = 250;

/**
 * Collapse a burst of calls into one: the first call in a quiet period runs at
 * once, further calls inside the window run once more at its end.
 */
export function coalesceCalls(callback: () => void, windowMs: number, clock: () => number = Date.now): { call: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let pending = false;
  const run = () => {
    pending = false;
    lastRunAt = clock();
    callback();
  };
  return {
    call() {
      const elapsed = clock() - lastRunAt;
      if (timer === null && elapsed >= windowMs) {
        run();
        return;
      }
      pending = true;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          if (pending) run();
        }, Math.max(0, windowMs - elapsed));
      }
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = false;
    },
  };
}

export const WORKSPACE_STARTUP_TIMEOUT_MS = 120_000;
export type WorkspaceReadiness = { state: "starting" | "ready" | "error"; error: string };

export class WorkspaceChangedError extends Error {}

async function waitForWorkspaceWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { const value = await Promise.race([work, cancelled]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener("abort", cancel); }
}

export type WorkspaceReadinessScope = {
  readiness: ReturnType<typeof createWorkspaceReadiness>;
  expected: ExpectedWorkspaceReadiness;
};

export async function prepareCurrentWorkspace<T>(current: () => WorkspaceReadinessScope, prepare: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("AI preparation did not settle within two minutes. Your draft is kept; retry preparation in Settings.")), WORKSPACE_STARTUP_TIMEOUT_MS);
  try {
    for (;;) {
      signal.throwIfAborted();
      deadline.signal.throwIfAborted();
      const scope = current();
      const scoped = AbortSignal.any([signal, deadline.signal, scope.readiness.signal]);
      try {
        await scope.readiness.wait(scoped);
        const value = await waitForWorkspaceWork(prepare(scoped), scoped);
        const assertCurrent = () => {
          scoped.throwIfAborted();
          if (current().readiness !== scope.readiness) throw new WorkspaceChangedError("The AI configuration changed. Your draft is kept.");
        };
        assertCurrent();
        return { value, expected: scope.expected, assertCurrent };
      } catch (cause) {
        signal.throwIfAborted();
        deadline.signal.throwIfAborted();
        if (current().readiness === scope.readiness) throw cause;
      }
    }
  } finally { clearTimeout(timer); }
}

export function createWorkspaceReadiness(prepare: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  let state: WorkspaceReadiness = { state: "starting", error: "" };
  let pending: Promise<void> | undefined;
  let owners = 0;
  const listeners = new Set<() => void>();
  const publish = (next: WorkspaceReadiness) => { state = next; for (const listener of listeners) listener(); };
  const dispose = () => {
    if (controller.signal.aborted) return;
    const cause = new WorkspaceChangedError("AI preparation changed or was cancelled. Your draft is kept.");
    controller.abort(cause);
    publish({ state: "error", error: cause.message });
  };
  return {
    signal: controller.signal,
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async wait(signal?: AbortSignal) {
      controller.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (!pending) {
        const attempt = new AbortController();
        const scoped = AbortSignal.any([controller.signal, attempt.signal]);
        const timer = setTimeout(() => attempt.abort(new Error("Starting AI took longer than two minutes. Retry preparation or restart AI in Settings. Your draft is kept.")), WORKSPACE_STARTUP_TIMEOUT_MS);
        publish({ state: "starting", error: "" });
        const work = waitForWorkspaceWork(Promise.resolve().then(() => { scoped.throwIfAborted(); return prepare(scoped); }), scoped)
          .then(() => { scoped.throwIfAborted(); publish({ state: "ready", error: "" }); })
          .catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : "AI preparation is unavailable.";
            publish({ state: "error", error: message.includes("draft is kept") ? message : `${message} Retry preparation or restart AI in Settings. Your draft is kept.` });
            throw cause;
          }).finally(() => { clearTimeout(timer); if (pending === work && state.state !== "ready") pending = undefined; });
        pending = work;
      }
      return signal ? waitForWorkspaceWork(pending, signal) : pending;
    },
    retain() {
      owners += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        owners -= 1;
        queueMicrotask(() => { if (owners === 0) dispose(); });
      };
    },
    dispose,
  };
}

export type WorkspacePreparationScope = { runtimeKey: string; workspaceKey: string; configurationKey: string };

export function runtimeWorkspaceReadinessKey(runtime: RuntimeInfo, workspaceId: string): string {
  return JSON.stringify([runtime.serverUrl, runtime.ownerToken, runtime.engineManaged, runtime.engineError, runtime.readinessKey, runtime.workspaceReadinessRevisions?.[workspaceId] ?? 0]);
}

export function workspacePreparationScope(runtime: RuntimeInfo, coworker: CoworkerSummary, session: Pick<DenSession, "baseUrl" | "orgId" | "token"> | null): WorkspacePreparationScope {
  return {
    runtimeKey: JSON.stringify([runtimeWorkspaceReadinessKey(runtime, ""), session?.baseUrl, session?.orgId, session?.token]),
    workspaceKey: JSON.stringify([coworker.slug, coworker.createdAt, coworker.path, coworker.workspaceId]),
    configurationKey: JSON.stringify([runtime.workspaceReadinessRevisions?.[`coworker:${coworker.slug}`] ?? runtime.workspaceReadinessRevisions?.[coworker.workspaceId] ?? 0, coworker.model, coworker.modelVariant,
      coworker.modelMode, coworker.modelChosenBy, coworker.useAppModelDefaults, coworker.modelSelectionPreferences, coworker.effortPreference,
      coworker.thinkingModel, coworker.thinkingModelVariant, coworker.deliveryModel, coworker.deliveryModelVariant]),
  };
}

export function createWorkspaceReadinessCache(limit = 32) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("A readiness cache needs a positive entry limit.");
  let runtimeKey = "";
  const entries = new Map<string, { scope: WorkspacePreparationScope; readiness: ReturnType<typeof createWorkspaceReadiness>; release: () => void }>();
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    entry.readiness.dispose();
    entry.release();
  };
  const dispose = () => { for (const key of entries.keys()) remove(key); };
  return {
    get(scope: WorkspacePreparationScope, prepare: (signal: AbortSignal) => Promise<void>) {
      if (scope.runtimeKey !== runtimeKey) { dispose(); runtimeKey = scope.runtimeKey; }
      let entry = entries.get(scope.workspaceKey);
      if (entry && (entry.scope.configurationKey !== scope.configurationKey || entry.readiness.signal.aborted)) {
        remove(scope.workspaceKey);
        entry = undefined;
      }
      if (!entry) {
        const readiness = createWorkspaceReadiness(prepare);
        entry = { scope, readiness, release: readiness.retain() };
      }
      entries.delete(scope.workspaceKey);
      entries.set(scope.workspaceKey, entry);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
      return entry.readiness;
    },
    peek(scope: WorkspacePreparationScope): WorkspaceReadiness | undefined {
      const entry = entries.get(scope.workspaceKey);
      return runtimeKey === scope.runtimeKey && entry?.scope.configurationKey === scope.configurationKey && !entry.readiness.signal.aborted ? entry.readiness.snapshot() : undefined;
    },
    invalidate(scope: WorkspacePreparationScope, expected?: ReturnType<typeof createWorkspaceReadiness>) {
      const entry = entries.get(scope.workspaceKey);
      if (runtimeKey === scope.runtimeKey && entry?.scope.configurationKey === scope.configurationKey && (!expected || entry.readiness === expected)) remove(scope.workspaceKey);
    },
    dispose,
  };
}

export const workspaceReadinessCache = createWorkspaceReadinessCache();

export function projectWorkspaceReadiness(activity: CoworkerActivity | null, preparation?: WorkspaceReadiness): CoworkerActivity {
  if (activity && (["working", "retrying", "attention", "offline"].includes(activity.state) || (activity.state === "recent" && !["Ready", "Idle", "Available"].includes(activity.label)))) return activity;
  if (preparation?.state === "starting" || preparation?.state === "error") return {
    ...activity, state: preparation.state === "starting" ? "starting" : "offline", label: preparation.state === "starting" ? "Starting AI" : "AI unavailable", detail: preparation.error, updatedAt: 0,
  };
  // No preparation yet means the coworker can be started on demand. Reserve
  // "Ready" for a verified warm workspace; avoid presenting "Idle" as disabled.
  return { detail: "", updatedAt: 0, ...activity, state: activity?.state === "recent" ? "recent" : preparation?.state === "ready" ? "ready" : "idle", label: preparation?.state === "ready" ? "Ready" : "Available" };
}

export function createCoworkerThreads(options: {
  serverUrl: string;
  workspaceId: string;
  token: string;
  /** "providerId/modelId"; empty or invalid falls back to the engine default. */
  model?: string;
  /** Optional reasoning/behavior variant supported by the selected model. */
  modelVariant?: string;
  /** The open discussion: a native session reserved for conversation rather than assigned work. */
  conversationThreadId?: string;
  /** Every discussion this coworker holds, open or not; none of them is an assignment. */
  discussionThreadIds?: readonly string[];
  /** The coworker's Workers' own threads; they count as work in progress, never as assignments. */
  workerThreadIds?: readonly string[];
  /**
   * The coworker these threads belong to. The team shares one workspace, so
   * every session the client creates is bound to `coworker-<slug>` and marked
   * with the owner, and listings show only that coworker's own sessions.
   */
  owner?: { slug: string; createdAt?: string };
}): CoworkerThreads {
  const parsedModel = parseModelPreference(options.model ?? "");
  const discussions = discussionIds(options.discussionThreadIds ?? [], options.conversationThreadId);
  const workerIds = new Set(options.workerThreadIds ?? []);
  const notAssignments = [...discussions, ...workerIds];
  const owner = options.owner;
  const access = coworkerSessionAccess();
  const agentId = owner && access ? coworkerAgent(owner.slug) : "build";
  const routed = access ? sessionRouting({ baseUrl: options.serverUrl, workspaceId: options.workspaceId, owner, access }) : undefined;
  const nativeOptions: NativeV2ClientOptions = {
    baseUrl: options.serverUrl, workspaceId: options.workspaceId, token: options.token, fetch: routed, apiContract: access?.apiContract?.(),
  };
  const headless = createHeadlessThreadClientV2({
    ...nativeOptions,
    defaultModel: parsedModel
      ? { ...parsedModel, variant: options.modelVariant?.trim() || undefined }
      : undefined,
    defaultAgent: agentId,
  });
  const ownedSessionIds = new Set<string>();
  const client: typeof headless = owner && access
    ? { ...headless, createThread: async (input) => { const thread = await access.create(owner, { ...input, model: input.model ?? parsedModel ?? undefined }); ownedSessionIds.add(thread.id); return thread; } }
    : headless;

  const native = createNativeV2Client(nativeOptions);

  async function prepare(signal: AbortSignal, selection?: Parameters<CoworkerThreads["prepare"]>[1]): Promise<void> {
    const startup = createNativeV2Client({ ...nativeOptions, requestTimeoutMs: WORKSPACE_STARTUP_TIMEOUT_MS, signal });
    const [agent, catalog] = await Promise.all([startup.getAgent(agentId, signal), listModelCatalog(signal)]);
    if (agent.id !== agentId) throw new Error("The native agent identity could not be confirmed.");
    const decision = selection ? resolveDiscussionModel(catalog, selection.coworker, selection.requestText ?? "", selection.defaults) : null;
    if (decision && !decision.model) throw new Error(decision.reason);
    const model = decision?.model ? { providerID: decision.model.providerId, id: decision.model.modelId, variant: decision.variant }
      : parsedModel ? { providerID: parsedModel.providerId, id: parsedModel.modelId, variant: options.modelVariant } : agent.model ?? await startup.defaultModel(signal);
    signal.throwIfAborted();
    if (!model || !catalog.connectedProviderIds.includes(model.providerID) || !catalog.models.some((item) => item.providerId === model.providerID && item.modelId === model.id && (!model.variant || model.variant === "default" || item.variants.includes(model.variant)))) {
      throw new Error("The selected AI model is unavailable. Choose or reconnect it in Settings. Your draft is kept.");
    }
  }

  async function listAllThreads(includeLegacy = true): Promise<ThreadListItem[]> {
    const [sessions, active] = await Promise.all([
      owner && access ? access.list(owner, includeLegacy) : native.listSessions(), native.readActive(),
    ]);
    ownedSessionIds.clear();
    for (const session of sessions) ownedSessionIds.add(session.id);
    const statuses = new Map<string, SessionStatus>();
    await Promise.all(sessions.filter((session) => Object.hasOwn(active, session.id)).map(async (session) => {
      const page = await native.readHistory(session.id);
      const last = page.filter((message) => message.type === "assistant").at(-1);
      const retry = last?.type === "assistant" && last.time.completed === undefined ? last.retry : undefined;
      statuses.set(session.id, retry ? { type: "retry", attempt: retry.attempt, next: retry.at, message: retry.error.message, reason: retry.error.type } : { type: "busy" });
    }));
    return sessions
      .filter((session) => !session.parentID)
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || "Untitled thread",
        createdAt: session.time?.created ?? 0,
        updatedAt: session.time?.updated ?? 0,
        status: statuses.get(session.id)?.type ?? "idle",
        ...retryOf(statuses.get(session.id)),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function listThreads(): Promise<ThreadListItem[]> {
    return assignmentThreads(await listAllThreads(), notAssignments);
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
    await native.renameSession(threadId, title);
  }

  /**
   * Native controls are always read through their exact session-scoped routes,
   * including child sessions, rather than a location-wide ID-only reply API.
   */
  async function listPendingInteractions(signal?: AbortSignal): Promise<PendingInteractions> {
    const sessions = await native.listSessions(signal);
    const pending = await Promise.all(sessions.map((session) => listThreadInteractions(session.id, signal)));
    return {
      permissions: pending.flatMap((item) => item.permissions),
      questions: pending.flatMap((item) => item.questions),
    };
  }

  async function listThreadInteractions(threadId: string, signal?: AbortSignal): Promise<PendingInteractions> {
    const [permissions, forms] = await Promise.all([native.listPermissions(threadId, signal), native.listForms(threadId, signal)]);
    return {
      permissions: permissions.map(normalizeV2Permission),
      questions: forms.map(normalizeQuestion),
    };
  }

  async function replyPermission(permission: PendingPermission, reply: PermissionReply, signal?: AbortSignal): Promise<void> {
    if (permission.protocol !== "v2" || !permission.native || permission.native.id !== permission.id || permission.native.sessionID !== permission.sessionID) throw new Error("Read the exact native permission request again before replying.");
    await native.replyPermission(permission.native, reply, signal);
  }

  async function replyQuestion(question: PendingQuestion, answers: string[][], signal?: AbortSignal): Promise<void> {
    const form = question.native;
    if (!form || form.id !== question.id || form.sessionID !== question.sessionID) throw new Error("Read the exact native question again before replying.");
    normalizeQuestion(form);
    if (answers.length !== form.fields.length) throw new Error("Answer count does not match the native form.");
    const answer: Record<string, string | string[]> = {};
    for (const [index, field] of form.fields.entries()) {
      const values = (answers[index] ?? []).map((label) => {
        const matches = (field.options ?? []).filter((option) => option.label === label);
        if (matches.length > 1 || (!matches.length && field.custom !== true && field.options?.length)) throw new Error("Answer does not identify one native option.");
        return matches[0]?.value ?? label;
      });
      if (field.type === "string" && values.length > 1) throw new Error("This native question accepts one answer.");
      if (values.length) answer[field.key] = field.type === "multiselect" ? values : values[0] ?? "";
    }
    await native.replyForm(form, answer, signal);
  }

  async function rejectQuestion(question: PendingQuestion, signal?: AbortSignal): Promise<void> {
    if (!question.native || question.native.id !== question.id || question.native.sessionID !== question.sessionID) throw new Error("Read the exact native question again before dismissing it.");
    await native.replyForm(question.native, null, signal);
  }

  async function readActivity(): Promise<CoworkerActivity> {
    const allSessions = await listAllThreads(false);
    // A thread waiting on a person (a permission, a question) is busy until it is answered, so
    // when nothing is running there is nothing pending to read; every coworker is read this
    // way every few seconds, and the two extra reads per coworker added up to most of the idle traffic.
    const anyRunning = allSessions.some((session) => session.status === "busy" || session.status === "retry");
    const pending = anyRunning
      ? await listPendingInteractions()
      : { permissions: [], questions: [] };
    const assignments = assignmentThreads(allSessions, notAssignments);
    const recentOf = (excludeId: string | undefined): RecentWork[] =>
      assignments
        .filter((session) => session.id !== excludeId && session.status === "idle")
        .slice(0, RECENT_WORK_LIMIT)
        .map((session) => ({
          id: session.id,
          title: session.title,
          kind: "assignment",
          outcome: "finished",
          finishedAt: session.updatedAt,
          threadId: session.id,
        }));
    if (hasPendingInteractions(pending)) {
      const sessionId = pending.permissions[0]?.sessionID ?? pending.questions[0]?.sessionID;
      const thread = allSessions.find((session) => session.id === sessionId);
      const recent = recentOf(sessionId);
      const last = recent[0];
      return {
        state: "attention",
        label: "Needs you",
        detail: describeInteractions(pending),
        updatedAt: thread?.updatedAt ?? Date.now(),
        ...(sessionId ? { threadId: sessionId } : {}),
        ...(last ? { last: { title: last.title, updatedAt: last.finishedAt, threadId: last.id } } : {}),
        recent,
      };
    }
    // The coworker's own turn is the subject when it has one; otherwise a Worker's turn is.
    const busy = allSessions.filter((session) => session.status === "busy" || session.status === "retry");
    const runningWorkers = busy.filter((session) => workerIds.has(session.id)).length;
    const active = busy.find((session) => !workerIds.has(session.id)) ?? busy[0];
    const recent = recentOf(active?.id);
    const last = recent[0];
    const subjectIsWorker = active !== undefined && workerIds.has(active.id);
    const workers = runningWorkers > 0 ? { workers: { running: runningWorkers, subject: subjectIsWorker } } : {};
    if (active?.status === "retry") {
      const stalled = stalledRetry(active.retry);
      return {
        state: "retrying",
        label: stalled ? "Paused" : "Retrying",
        detail: subjectIsWorker ? workerNameFromTitle(active.title) : active.title,
        ...(stalled ? { reason: stalled } : {}),
        updatedAt: active.updatedAt,
        threadId: active.id,
        ...(last ? { last: { title: last.title, updatedAt: last.finishedAt, threadId: last.id } } : {}),
        recent,
        ...workers,
      };
    }
    if (active) {
      return {
        state: "working",
        label: "Working",
        detail: subjectIsWorker ? workerNameFromTitle(active.title) : active.title,
        updatedAt: active.updatedAt,
        threadId: active.id,
        ...(last ? { last: { title: last.title, updatedAt: last.finishedAt, threadId: last.id } } : {}),
        recent,
        ...workers,
      };
    }
    if (last) {
      return {
        state: "recent",
        label: "Idle",
        detail: last.title,
        updatedAt: last.finishedAt,
        threadId: last.id,
        last: { title: last.title, updatedAt: last.finishedAt, threadId: last.id },
        recent,
      };
    }
    return { state: "idle", label: "Idle", detail: "Waiting for first assignment", updatedAt: 0, recent: [] };
  }

  async function listModelCatalog(signal?: AbortSignal): Promise<EngineModelCatalog> {
    const source = signal ? createNativeV2Client({ ...nativeOptions, requestTimeoutMs: WORKSPACE_STARTUP_TIMEOUT_MS, signal }) : native;
    const [result, preferred, cloud] = await Promise.all([
      source.readCatalog(signal), source.defaultModel(signal),
      // Status is advisory: without it, account providers are still recognised by their ids.
      readCloudProviderSyncStatus({ serverUrl: options.serverUrl, token: options.token }).catch(
        (): CloudProviderSyncStatus | null => null,
      ),
    ]);
    return connectedModelCatalog(
      {
        connected: result.connectedProviderIds,
        default: preferred ? { [preferred.providerID]: preferred.id } : {},
        all: result.providers.map((provider) => ({
          id: provider.id, name: provider.name,
          options: { baseURL: provider.settings?.baseURL },
          models: Object.fromEntries(result.models.filter((model) => model.enabled && model.providerID === provider.id).map((model) => {
            const price = model.cost.find((cost) => !cost.tier);
            const modalities = (values: string[]) => Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((kind) => [kind, values.some((value) => value === kind || value.startsWith(`${kind}/`))]));
            return [model.id, {
              ...modelCatalogIdentity(model),
              name: model.name, family: model.family, variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
              status: model.status, release_date: model.time.released > 0 ? new Date(model.time.released).toISOString().slice(0, 10) : "",
              ...(price ? { cost: { input: price.input, output: price.output } } : {}),
              api: { npm: model.package ?? provider.package, id: model.modelID }, limit: model.limit,
              capabilities: { toolcall: model.capabilities.tools, reasoning: model.capabilities.output.includes("reasoning"), input: modalities(model.capabilities.input), output: modalities(model.capabilities.output) },
            }];
          })),
        })),
      },
      cloud,
    );
  }

  async function listModels(): Promise<EngineModelOption[]> {
    return (await listModelCatalog()).models;
  }

  function subscribe(onEvent: () => void, onStream?: (event: StreamEvent) => void, onConfigurationChange?: () => void): () => void {
    const controller = new AbortController();
    // A streaming reply raises a message event for every part update; each one
    // used to trigger a full transcript re-read. Message events now collapse into
    // one refresh per short window, while a question, a permission, or a change
    // of the thread's status still refreshes at once.
    const messageRefresh = coalesceCalls(onEvent, EVENT_REFRESH_WINDOW_MS);
    void (async () => {
      try {
        for await (const event of native.events(controller.signal)) {
          if (controller.signal.aborted) return;
          if (["catalog.updated", "integration.updated", "model.updated", "provider.updated"].includes(event.type)) onConfigurationChange?.();
          if (onStream && /^session\.(text|reasoning)\.(started|delta|ended)$/.test(event.type)) {
            const part = z.object({ sessionID: z.string(), assistantMessageID: z.string(), ordinal: z.number().int().nonnegative(), delta: z.string().optional(), text: z.string().optional() }).parse(event.data);
            if (owner && access && !ownedSessionIds.has(part.sessionID)) continue;
            const identity = { threadId: part.sessionID, messageId: part.assistantMessageID, partId: nativeV2PartId(part.assistantMessageID, part.ordinal, event.type.includes(".reasoning.") ? "reasoning" : "text") };
            if (event.type.endsWith(".delta")) {
              if (part.delta !== undefined) onStream({ kind: "delta", ...identity, delta: part.delta });
            } else {
              onStream({ kind: "part", ...identity, type: event.type.includes(".reasoning.") ? "reasoning" : "text", text: part.text ?? "", ended: event.type.endsWith(".ended") });
            }
          }
          if (/^session\.(text|reasoning|tool|step|message)\./.test(event.type)) {
            messageRefresh.call();
          } else if (
            event.type.startsWith("session.") ||
            event.type.startsWith("permission.") ||
            event.type.startsWith("form.") || ["catalog.updated", "integration.updated", "model.updated", "provider.updated"].includes(event.type)
          ) {
            messageRefresh.cancel();
            onEvent();
          }
        }
      } catch {
        // A bounded poll in the renderer remains the reconnect/backstop path.
      } finally {
        messageRefresh.cancel();
      }
    })();
    return () => {
      controller.abort();
      messageRefresh.cancel();
    };
  }

  return {
    client,
    prepare,
    listThreads,
    listAllThreads,
    renameThread,
    listModelCatalog,
    listModels,
    listSkills: (signal) => native.listSkills(signal),
    readActivity,
    listPendingInteractions,
    listThreadInteractions,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    subscribe,
  };
}

export async function readCoworkerActivity(options: {
  serverUrl: string;
  workspaceId: string;
  token: string;
  owner: { slug: string; createdAt?: string };
  conversationThreadId?: string;
  workerThreadIds?: readonly string[];
  preparationScope?: WorkspacePreparationScope;
}): Promise<CoworkerActivity> {
  try {
    // Discussions other than the open one are only known to the coworker's registry.
    const discussionThreadIds = await discussionIdsForCoworker(options.owner.slug, options.conversationThreadId)
      .catch(() => discussionIds([], options.conversationThreadId));
    const activity = await createCoworkerThreads({ ...options, discussionThreadIds }).readActivity();
    return projectWorkspaceReadiness(activity, options.preparationScope ? workspaceReadinessCache.peek(options.preparationScope) : undefined);
  } catch {
    return { state: "offline", label: "Not responding", detail: "", updatedAt: 0 };
  }
}
