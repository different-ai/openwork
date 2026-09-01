/**
 * Open Coworker threads are native OpenWork sessions in the coworker's workspace,
 * driven through the shared `@openwork/headless-threads` client against the
 * embedded server's workspace-scoped engine proxy. Nothing here invents a
 * conversation type: a thread created in Open Coworker opens in OpenWork.
 */
import { createOpencodeClient, type SessionStatus } from "@opencode-ai/sdk/v2/client";
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
  state: "ready" | "working" | "retrying" | "recent" | "offline";
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
  label: string;
};

const providersSchema = z.object({
  providers: z.array(
    z
      .object({
        id: z.string(),
        name: z.string().optional(),
        models: z.record(z.string(), z.unknown()).optional(),
      })
      .loose(),
  ),
});

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
}): CoworkerThreads {
  const client = createHeadlessThreadClient({
    baseUrl: options.serverUrl,
    workspaceId: options.workspaceId,
    token: options.token,
    defaultModel: parseModelPreference(options.model ?? ""),
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

  async function listModels(): Promise<EngineModelOption[]> {
    const response = await fetch(
      `${options.serverUrl}/workspace/${encodeURIComponent(options.workspaceId)}/opencode/config/providers`,
      { headers: { Authorization: `Bearer ${options.token}` } },
    );
    if (!response.ok) {
      throw new Error(`Listing models failed (${response.status})`);
    }
    const parsed = providersSchema.parse(await response.json());
    const models: EngineModelOption[] = [];
    for (const provider of parsed.providers) {
      for (const modelId of Object.keys(provider.models ?? {})) {
        models.push({
          id: `${provider.id}/${modelId}`,
          label: `${provider.name?.trim() || provider.id} · ${modelId}`,
        });
      }
    }
    return models.sort((a, b) => a.label.localeCompare(b.label));
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

  return { client, listThreads, listModels, readActivity, subscribe };
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
