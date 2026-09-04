/**
 * Open Coworker threads are native OpenWork sessions in the coworker's workspace,
 * driven through the shared `@openwork/headless-threads` client against the
 * embedded server's workspace-scoped engine proxy. Nothing here invents a
 * conversation type: a thread created in Open Coworker opens in OpenWork.
 */
import {
  createOpencodeClient,
  type ProviderListResponse,
  type SessionStatus,
} from "@opencode-ai/sdk/v2/client";
import {
  createHeadlessThreadClient,
  type HeadlessThreadClient,
} from "@openwork/headless-threads";
import { z } from "zod";
import { RECENT_WORK_LIMIT } from "./activity-summary.ts";
import { readCloudProviderSyncStatus, type CloudProviderSyncStatus } from "./den.ts";
import { discussionIds, discussionIdsForWorkspace } from "./discussions.ts";
import type { StreamEvent } from "./live-stream.ts";
import { workerNameFromTitle } from "./workers.ts";

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
  state: "ready" | "working" | "retrying" | "attention" | "recent" | "starting" | "offline";
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

const sessionListSchema = z.array(
  z
    .object({
      id: z.string(),
      title: z.string().optional(),
      parentID: z.string().optional(),
      time: z.object({ created: z.number(), updated: z.number() }).partial().optional(),
    })
    .loose(),
);

/**
 * Where a connected provider comes from: `cloud` providers were materialized
 * into this engine from the signed-in OpenWork account (organization access,
 * Den-backed inference); `local` providers were configured on this Mac.
 */
export type ModelSource = "cloud" | "local";

/**
 * What stands behind a model, in the order a coworker should prefer when
 * nobody chose: the OpenWork account, a subscription or key on this Mac, a
 * model server running on this Mac, and last the free model that needs
 * nothing at all.
 */
export type ModelTier = "cloud" | "key" | "local-server" | "free";

export const MODEL_TIER_ORDER: readonly ModelTier[] = ["cloud", "key", "local-server", "free"];

/** The provider whose models cost nothing and need no setup. */
export const FREE_PROVIDER_ID = "opencode";

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
  if (source === "cloud") return "cloud";
  if (provider.id === FREE_PROVIDER_ID) return "free";
  return isLocalServerProvider(provider) ? "local-server" : "key";
}

export type EngineModelOption = {
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
  /** What the provider charges per million tokens; 0/0 for a free model. A lane pick never costs more than the standard model. */
  cost: { input: number; output: number };
};

export type EngineModelCatalog = {
  models: EngineModelOption[];
  connectedProviderIds: string[];
  /** Account provider sync state; null when the embedded server did not report it. */
  cloud: CloudProviderSyncStatus | null;
};

/** Engine provider keys owned by the OpenWork account sync (`lpr_*` records and the hosted `openwork` provider). */
export function isCloudManagedProviderId(providerId: string): boolean {
  return /^lpr_/i.test(providerId) || providerId.trim() === "openwork";
}

export function modelSourceLabel(source: ModelSource): string {
  return source === "cloud" ? "OpenWork Cloud" : "This Mac";
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
export function stalledRetry(retry: { next: number; message: string } | undefined, now = Date.now()): string | null {
  if (!retry || !Number.isFinite(retry.next) || retry.next - now <= FAR_RETRY_MS) return null;
  const reason = retry.message.trim().replace(/[.\s]+$/, "");
  return reason || "The AI provider is not answering";
}

/**
 * The engine reports each session as idle, busy, or retrying (with the time of the next
 * attempt). A retry whose next attempt is long past is stale — the attempt already happened
 * and the reply landed, or the run ended — so it reads as idle rather than keeping a finished
 * coworker "Retrying".
 */
export function threadStatusOf(status: SessionStatus | undefined, now = Date.now()): SessionStatus["type"] {
  if (!status) return "idle";
  if (status.type === "retry" && Number.isFinite(status.next) && now - status.next > STALE_RETRY_MS) return "idle";
  return status.type;
}

export function connectedModelCatalog(
  value: ProviderListResponse,
  cloud: CloudProviderSyncStatus | null = null,
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
      const providerLabel = provider.name?.trim() || provider.id;
      const modelLabel = model.name?.trim() || modelId;
      const source: ModelSource =
        cloudProviderIds.has(provider.id) || isCloudManagedProviderId(provider.id) ? "cloud" : "local";
      return {
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
      };
    }),
  );
  // Account providers first: they are what "Continue with OpenWork" promised.
  models.sort((left, right) =>
    Number(right.source === "cloud") - Number(left.source === "cloud") ||
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
 * server, and only then the free model — preferring the provider's own
 * default, then the newest release. Returns null when no connected model can
 * use tools, so the caller can say so instead of picking something that would
 * fail. Coworkers that chose a model keep it; this only fills a blank.
 */
export function recommendModel(
  catalog: Pick<EngineModelCatalog, "models">,
  options: { exclude?: string | readonly string[] } = {},
): EngineModelOption | null {
  const excluded = new Set(typeof options.exclude === "string" ? [options.exclude] : options.exclude ?? []);
  const candidates = catalog.models.filter(
    (model) => model.toolCall && model.status !== "deprecated" && !excluded.has(model.id),
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
 * A tool permission the engine is holding a turn on. Both OpenCode permission
 * protocols are normalized here so the UI renders one card and replies through
 * whichever endpoint issued the request — the same split the OpenWork desktop
 * handles in its session sync.
 */
export type PendingPermission = {
  id: string;
  sessionID: string;
  protocol: "legacy" | "v2";
  /** Legacy `permission` or v2 `action`, e.g. `bash`, `edit`, `external_directory`. */
  action: string;
  /** Legacy `patterns` or v2 `resources`: paths, commands, or URLs the request covers. */
  resources: string[];
  /** Whether "always allow" is offered for this request. */
  canAlways: boolean;
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
  questions: PendingQuestionItem[];
};

export type PendingInteractions = {
  permissions: PendingPermission[];
  questions: PendingQuestion[];
};

export type PermissionReply = "once" | "always" | "reject";

const ACTION_LABELS: Record<string, string> = {
  external_directory: "work outside its home folder",
  bash: "run a command",
  edit: "change files",
  write: "write files",
  read: "read files",
  webfetch: "fetch a web page",
  websearch: "search the web",
  task: "start a sub-task",
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
  /** Assignment threads only; discussions are excluded. */
  listThreads: () => Promise<ThreadListItem[]>;
  /** Every top-level thread in the workspace, discussions included, newest first. */
  listAllThreads: () => Promise<ThreadListItem[]>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  listModelCatalog: () => Promise<EngineModelCatalog>;
  listModels: () => Promise<EngineModelOption[]>;
  readActivity: () => Promise<CoworkerActivity>;
  /** Pending permissions and questions across the coworker's threads. */
  listPendingInteractions: () => Promise<PendingInteractions>;
  /** Pending permissions and questions for one thread, including v2 session-scoped requests. */
  listThreadInteractions: (threadId: string) => Promise<PendingInteractions>;
  replyPermission: (permission: PendingPermission, reply: PermissionReply) => Promise<void>;
  replyQuestion: (question: PendingQuestion, answers: string[][]) => Promise<void>;
  rejectQuestion: (question: PendingQuestion) => Promise<void>;
  /**
   * Follow the engine's events. `onEvent` fires for anything worth a re-read;
   * `onStream`, when given, also receives the words of a reply as they arrive
   * (the engine writes a text or reasoning part only once it has ended).
   */
  subscribe: (onEvent: () => void, onStream?: (event: StreamEvent) => void) => () => void;
};

function normalizeLegacyPermission(value: {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always: string[];
}): PendingPermission {
  return {
    id: value.id,
    sessionID: value.sessionID,
    protocol: "legacy",
    action: value.permission,
    resources: value.patterns,
    canAlways: value.always.length > 0,
  };
}

function normalizeV2Permission(value: {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
}): PendingPermission {
  return {
    id: value.id,
    sessionID: value.sessionID,
    protocol: "v2",
    action: value.action,
    resources: value.resources,
    canAlways: (value.save?.length ?? 0) > 0,
  };
}

function normalizeQuestion(value: {
  id: string;
  sessionID: string;
  questions: Array<{
    header: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
}): PendingQuestion {
  return {
    id: value.id,
    sessionID: value.sessionID,
    questions: value.questions.map((question) => ({
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({ label: option.label, description: option.description ?? "" })),
      multiple: question.multiple === true,
      custom: question.custom !== false,
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
}): CoworkerThreads {
  const parsedModel = parseModelPreference(options.model ?? "");
  const discussions = discussionIds(options.discussionThreadIds ?? [], options.conversationThreadId);
  const workerIds = new Set(options.workerThreadIds ?? []);
  const notAssignments = [...discussions, ...workerIds];
  const client = createHeadlessThreadClient({
    baseUrl: options.serverUrl,
    workspaceId: options.workspaceId,
    token: options.token,
    defaultModel: parsedModel
      ? { ...parsedModel, variant: options.modelVariant?.trim() || undefined }
      : undefined,
  });

  const opencode = createOpencodeClient({
    baseUrl: `${options.serverUrl}/workspace/${encodeURIComponent(options.workspaceId)}/opencode`,
    headers: { Authorization: `Bearer ${options.token}` },
    redirect: "error",
  });

  async function listAllThreads(): Promise<ThreadListItem[]> {
    const [listResult, statusResult] = await Promise.all([
      opencode.session.list(),
      opencode.session.status(),
    ]);
    if (listResult.error !== undefined) {
      throw new Error(`Listing threads failed (${listResult.response?.status ?? "network"})`);
    }
    const sessions = sessionListSchema.parse(listResult.data ?? []);
    const statuses = statusResult.data ?? {};
    return sessions
      .filter((session) => !session.parentID)
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || "Untitled thread",
        createdAt: session.time?.created ?? 0,
        updatedAt: session.time?.updated ?? 0,
        status: threadStatusOf(statuses[session.id]),
        ...retryOf(statuses[session.id]),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function listThreads(): Promise<ThreadListItem[]> {
    return assignmentThreads(await listAllThreads(), notAssignments);
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
    const result = await opencode.session.update({ sessionID: threadId, title });
    if (result.error !== undefined) {
      throw new Error(`Renaming the thread failed (${result.response?.status ?? "network"})`);
    }
  }

  /**
   * Workspace-wide pending requests. The legacy lists are already scoped to
   * this coworker's directory by the workspace proxy; v2 requests are
   * session-scoped and read per thread in `listThreadInteractions`.
   */
  async function listPendingInteractions(): Promise<PendingInteractions> {
    const [permissionsResult, questionsResult] = await Promise.all([
      opencode.permission.list(),
      opencode.question.list(),
    ]);
    return {
      permissions: (permissionsResult.data ?? []).map(normalizeLegacyPermission),
      questions: (questionsResult.data ?? []).map(normalizeQuestion),
    };
  }

  async function listThreadInteractions(threadId: string): Promise<PendingInteractions> {
    const [workspaceWide, v2Result] = await Promise.all([
      listPendingInteractions(),
      opencode.v2.session.permission.list({ sessionID: threadId }).catch(() => undefined),
    ]);
    const legacy = workspaceWide.permissions.filter((permission) => permission.sessionID === threadId);
    const v2 = (v2Result?.data?.data ?? []).map(normalizeV2Permission);
    const seen = new Set(legacy.map((permission) => permission.id));
    return {
      permissions: [...legacy, ...v2.filter((permission) => !seen.has(permission.id))],
      questions: workspaceWide.questions.filter((question) => question.sessionID === threadId),
    };
  }

  async function replyPermission(permission: PendingPermission, reply: PermissionReply): Promise<void> {
    const result =
      permission.protocol === "v2"
        ? await opencode.v2.session.permission.reply({ sessionID: permission.sessionID, requestID: permission.id, reply })
        : await opencode.permission.reply({ requestID: permission.id, reply });
    if (result.error !== undefined) {
      throw new Error(`Replying to the permission request failed (${result.response?.status ?? "network"})`);
    }
  }

  async function replyQuestion(question: PendingQuestion, answers: string[][]): Promise<void> {
    const result = await opencode.question.reply({ requestID: question.id, answers });
    if (result.error !== undefined) {
      throw new Error(`Answering the question failed (${result.response?.status ?? "network"})`);
    }
  }

  async function rejectQuestion(question: PendingQuestion): Promise<void> {
    const result = await opencode.question.reject({ requestID: question.id });
    if (result.error !== undefined) {
      throw new Error(`Skipping the question failed (${result.response?.status ?? "network"})`);
    }
  }

  async function readActivity(): Promise<CoworkerActivity> {
    const allSessions = await listAllThreads();
    // A thread waiting on a person (a permission, a question) is busy until it is answered, so
    // when nothing is running there is nothing pending to read; every coworker is read this
    // way every few seconds, and the two extra reads per coworker added up to most of the idle traffic.
    const anyRunning = allSessions.some((session) => session.status === "busy" || session.status === "retry");
    const pending = anyRunning
      ? await listPendingInteractions().catch((): PendingInteractions => ({ permissions: [], questions: [] }))
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
        label: "Ready",
        detail: last.title,
        updatedAt: last.finishedAt,
        threadId: last.id,
        last: { title: last.title, updatedAt: last.finishedAt, threadId: last.id },
        recent,
      };
    }
    return { state: "ready", label: "Ready", detail: "Waiting for first assignment", updatedAt: 0, recent: [] };
  }

  async function listModelCatalog(): Promise<EngineModelCatalog> {
    const [result, cloud] = await Promise.all([
      // Only providers that are actually connected: a few kilobytes, where the full
      // provider list (every provider the engine knows, thousands of models) is
      // megabytes per read and this catalog is read often.
      opencode.config.providers(),
      // Status is advisory: without it, account providers are still recognised by their ids.
      readCloudProviderSyncStatus({ serverUrl: options.serverUrl, token: options.token }).catch(
        (): CloudProviderSyncStatus | null => null,
      ),
    ]);
    if (result.error !== undefined || !result.data) {
      throw new Error(`Listing models failed (${result.response?.status ?? "network"})`);
    }
    return connectedModelCatalog(
      { all: result.data.providers, connected: result.data.providers.map((provider) => provider.id), default: result.data.default },
      cloud,
    );
  }

  async function listModels(): Promise<EngineModelOption[]> {
    return (await listModelCatalog()).models;
  }

  function subscribe(onEvent: () => void, onStream?: (event: StreamEvent) => void): () => void {
    const controller = new AbortController();
    // A streaming reply raises a message event for every part update; each one
    // used to trigger a full transcript re-read. Message events now collapse into
    // one refresh per short window, while a question, a permission, or a change
    // of the thread's status still refreshes at once.
    const messageRefresh = coalesceCalls(onEvent, EVENT_REFRESH_WINDOW_MS);
    void (async () => {
      try {
        const subscription = await opencode.event.subscribe(undefined, { signal: controller.signal });
        for await (const event of subscription.stream) {
          if (controller.signal.aborted) return;
          if (onStream && event.type === "message.part.delta") {
            const { sessionID, messageID, partID, delta } = event.properties;
            onStream({ kind: "delta", threadId: sessionID, messageId: messageID, partId: partID, delta });
            continue;
          }
          if (onStream && event.type === "message.part.updated") {
            const part = event.properties.part;
            if (part.type === "text" || part.type === "reasoning") {
              onStream({ kind: "part", threadId: part.sessionID, messageId: part.messageID, partId: part.id, type: part.type, text: part.text, ended: part.time?.end !== undefined });
            }
          }
          if (event.type.startsWith("message.")) {
            messageRefresh.call();
          } else if (
            event.type.startsWith("session.") ||
            event.type.startsWith("permission.") ||
            event.type.startsWith("question.")
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
    listThreads,
    listAllThreads,
    renameThread,
    listModelCatalog,
    listModels,
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
  conversationThreadId?: string;
  workerThreadIds?: readonly string[];
}): Promise<CoworkerActivity> {
  try {
    // Discussions other than the open one are only known to the coworker's registry.
    const discussionThreadIds = await discussionIdsForWorkspace(options.workspaceId, options.conversationThreadId)
      .catch(() => discussionIds([], options.conversationThreadId));
    return await createCoworkerThreads({ ...options, discussionThreadIds }).readActivity();
  } catch {
    return { state: "offline", label: "Not responding", detail: "", updatedAt: 0 };
  }
}
