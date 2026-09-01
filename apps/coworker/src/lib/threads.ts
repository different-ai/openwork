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

export type ThreadListItem = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus["type"];
};

/** Keep the coworker's standing discussion out of outcome-driven assignment lists. */
export function assignmentThreads<T extends { id: string }>(threads: T[], conversationThreadId?: string): T[] {
  const discussion = conversationThreadId?.trim();
  return discussion ? threads.filter((thread) => thread.id !== discussion) : threads;
}

export type CoworkerActivity = {
  state: "ready" | "working" | "retrying" | "attention" | "recent" | "offline";
  label: string;
  detail: string;
  updatedAt: number;
  /** Thread the current state refers to, when there is one to open. */
  threadId?: string;
  last?: {
    title: string;
    updatedAt: number;
    threadId?: string;
  };
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
};

export type EngineModelCatalog = {
  models: EngineModelOption[];
  connectedProviderIds: string[];
};

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

export function connectedModelCatalog(value: ProviderListResponse): EngineModelCatalog {
  const connected = new Set(value.connected ?? []);
  const providers = (value.all ?? []).filter(
    (provider) =>
      connected.has(provider.id) &&
      (provider.source !== "custom" || provider.id === "opencode" || Object.keys(provider.models ?? {}).length > 0),
  );
  const models = providers.flatMap((provider) =>
    Object.entries(provider.models ?? {}).map(([modelId, model]) => {
      const providerLabel = provider.name?.trim() || provider.id;
      const modelLabel = model.name?.trim() || modelId;
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
      };
    }),
  );
  models.sort((left, right) =>
    left.providerLabel.localeCompare(right.providerLabel) ||
    Number(right.isProviderDefault) - Number(left.isProviderDefault) ||
    left.modelLabel.localeCompare(right.modelLabel),
  );
  return { models, connectedProviderIds: providers.map((provider) => provider.id) };
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
  listThreads: () => Promise<ThreadListItem[]>;
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
  subscribe: (onEvent: () => void) => () => void;
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

export function createCoworkerThreads(options: {
  serverUrl: string;
  workspaceId: string;
  token: string;
  /** "providerId/modelId"; empty or invalid falls back to the engine default. */
  model?: string;
  /** Optional reasoning/behavior variant supported by the selected model. */
  modelVariant?: string;
  /** Native session reserved for ongoing discussion rather than assigned work. */
  conversationThreadId?: string;
}): CoworkerThreads {
  const parsedModel = parseModelPreference(options.model ?? "");
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
        status: statuses[session.id]?.type ?? "idle",
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function listThreads(): Promise<ThreadListItem[]> {
    return assignmentThreads(await listAllThreads(), options.conversationThreadId);
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
    const [allSessions, pending] = await Promise.all([
      listAllThreads(),
      listPendingInteractions().catch((): PendingInteractions => ({ permissions: [], questions: [] })),
    ]);
    const assignments = assignmentThreads(allSessions, options.conversationThreadId);
    if (hasPendingInteractions(pending)) {
      const sessionId = pending.permissions[0]?.sessionID ?? pending.questions[0]?.sessionID;
      const thread = allSessions.find((session) => session.id === sessionId);
      const last = assignments.find((session) => session.id !== sessionId && session.status === "idle");
      return {
        state: "attention",
        label: "Needs you",
        detail: describeInteractions(pending),
        updatedAt: thread?.updatedAt ?? Date.now(),
        ...(sessionId ? { threadId: sessionId } : {}),
        ...(last ? { last: { title: last.title, updatedAt: last.updatedAt, threadId: last.id } } : {}),
      };
    }
    const active = allSessions.find((session) => session.status === "busy" || session.status === "retry");
    const last = assignments.find((session) => session.id !== active?.id && session.status === "idle");
    if (active?.status === "retry") {
      return {
        state: "retrying",
        label: "Retrying",
        detail: active.title,
        updatedAt: active.updatedAt,
        threadId: active.id,
        ...(last ? { last: { title: last.title, updatedAt: last.updatedAt, threadId: last.id } } : {}),
      };
    }
    if (active) {
      return {
        state: "working",
        label: "Working",
        detail: active.title,
        updatedAt: active.updatedAt,
        threadId: active.id,
        ...(last ? { last: { title: last.title, updatedAt: last.updatedAt, threadId: last.id } } : {}),
      };
    }
    const latest = assignments[0];
    if (latest) {
      return {
        state: "recent",
        label: "Ready",
        detail: latest.title,
        updatedAt: latest.updatedAt,
        threadId: latest.id,
        last: { title: latest.title, updatedAt: latest.updatedAt, threadId: latest.id },
      };
    }
    return { state: "ready", label: "Ready", detail: "Waiting for first assignment", updatedAt: 0 };
  }

  async function listModelCatalog(): Promise<EngineModelCatalog> {
    const result = await opencode.provider.list();
    if (result.error !== undefined || !result.data) {
      throw new Error(`Listing models failed (${result.response?.status ?? "network"})`);
    }
    return connectedModelCatalog(result.data);
  }

  async function listModels(): Promise<EngineModelOption[]> {
    return (await listModelCatalog()).models;
  }

  function subscribe(onEvent: () => void): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const subscription = await opencode.event.subscribe(undefined, { signal: controller.signal });
        for await (const event of subscription.stream) {
          if (controller.signal.aborted) return;
          if (
            event.type.startsWith("session.") ||
            event.type.startsWith("message.") ||
            event.type.startsWith("permission.") ||
            event.type.startsWith("question.")
          ) {
            onEvent();
          }
        }
      } catch {
        // A bounded poll in the renderer remains the reconnect/backstop path.
      }
    })();
    return () => controller.abort();
  }

  return {
    client,
    listThreads,
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
}): Promise<CoworkerActivity> {
  try {
    return await createCoworkerThreads(options).readActivity();
  } catch {
    return { state: "offline", label: "Offline", detail: "Activity is unavailable", updatedAt: 0 };
  }
}
