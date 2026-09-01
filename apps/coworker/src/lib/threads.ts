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

export type CoworkerActivity = {
  state: "ready" | "working" | "retrying" | "attention" | "recent" | "offline";
  label: string;
  detail: string;
  updatedAt: number;
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

export type CoworkerThreads = {
  client: HeadlessThreadClient;
  listThreads: () => Promise<ThreadListItem[]>;
  listModelCatalog: () => Promise<EngineModelCatalog>;
  listModels: () => Promise<EngineModelOption[]>;
  readActivity: () => Promise<CoworkerActivity>;
  subscribe: (onEvent: () => void) => () => void;
};

export function createCoworkerThreads(options: {
  serverUrl: string;
  workspaceId: string;
  token: string;
  /** "providerId/modelId"; empty or invalid falls back to the engine default. */
  model?: string;
  /** Optional reasoning/behavior variant supported by the selected model. */
  modelVariant?: string;
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

  async function listThreads(): Promise<ThreadListItem[]> {
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

  async function readActivity(): Promise<CoworkerActivity> {
    const sessions = await listThreads();
    const active = sessions.find((session) => session.status === "busy" || session.status === "retry");
    if (active?.status === "retry") {
      return { state: "retrying", label: "Retrying", detail: active.title, updatedAt: active.updatedAt };
    }
    if (active) {
      return { state: "working", label: "Working", detail: active.title, updatedAt: active.updatedAt };
    }
    const latest = sessions[0];
    if (latest) {
      return { state: "recent", label: "Ready", detail: latest.title, updatedAt: latest.updatedAt };
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
          if (event.type.startsWith("session.") || event.type.startsWith("message.")) onEvent();
        }
      } catch {
        // A bounded poll in the renderer remains the reconnect/backstop path.
      }
    })();
    return () => controller.abort();
  }

  return { client, listThreads, listModelCatalog, listModels, readActivity, subscribe };
}

export async function readCoworkerActivity(options: {
  serverUrl: string;
  workspaceId: string;
  token: string;
}): Promise<CoworkerActivity> {
  try {
    return await createCoworkerThreads(options).readActivity();
  } catch {
    return { state: "offline", label: "Offline", detail: "Activity is unavailable", updatedAt: 0 };
  }
}
