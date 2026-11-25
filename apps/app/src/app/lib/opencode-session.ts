import type { Session } from "@opencode-ai/sdk/v2/client";
import type { Client, ModelRef } from "../types";
import { isOpencodeV2Client } from "./opencode-v2-adapter";
import { unwrap } from "./opencode";

export type AbortSessionLogContext = {
  source: string;
  initiator: "user" | "system" | "app";
  reason?: string;
};

function logAbortSession(
  phase: "start" | "done" | "error",
  sessionID: string,
  directory: string | undefined,
  context: AbortSessionLogContext | undefined,
  extra?: { aborted?: boolean; error?: string },
) {
  console.info("[opencode-session] abort", {
    phase,
    source: context?.source ?? "unknown",
    initiator: context?.initiator ?? "app",
    reason: context?.reason ?? null,
    sessionID,
    directoryScoped: Boolean(directory?.trim()),
    ...(extra ?? {}),
  });
}

export async function abortSession(
  client: Client,
  sessionID: string,
  directory?: string,
  logContext?: AbortSessionLogContext,
): Promise<boolean> {
  logAbortSession("start", sessionID, directory, logContext);
  try {
    const aborted = unwrap(await client.session.abort({ sessionID, directory })) === true;
    logAbortSession("done", sessionID, directory, logContext, { aborted });
    return aborted;
  } catch (error) {
    logAbortSession("error", sessionID, directory, logContext, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function abortSessionSafe(
  client: Client,
  sessionID: string,
  directory?: string,
  logContext?: AbortSessionLogContext,
): Promise<boolean> {
  try {
    return await abortSession(client, sessionID, directory, logContext);
  } catch {
    return false;
  }
}

export async function revertSession(
  client: Client,
  sessionID: string,
  messageID: string,
): Promise<Session> {
  return unwrap(await client.session.revert({ sessionID, messageID })) as Session;
}

export async function forkSession(
  client: Client,
  sessionID: string,
  messageID?: string,
): Promise<Session> {
  return unwrap(await client.session.fork({ sessionID, messageID })) as Session;
}

export async function unrevertSession(
  client: Client,
  sessionID: string,
): Promise<Session> {
  return unwrap(await client.session.unrevert({ sessionID })) as Session;
}

export async function setSessionArchived(
  client: Client,
  sessionID: string,
  archived: boolean,
  directory?: string,
  options?: { signal?: AbortSignal },
): Promise<Session> {
  return unwrap(
    await client.session.update({
      sessionID,
      directory,
      time: { archived: archived ? Date.now() : 0 },
    }, options),
  );
}

export async function setSessionModel(
  client: Client,
  sessionID: string,
  model: ModelRef,
  variant?: string | null,
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (!isOpencodeV2Client(client)) {
    throw new Error("Session model reassignment requires the OpenCode v2 session API.");
  }
  const response = await client.session.setModel({
    sessionID,
    model: { providerID: model.providerID, modelID: model.modelID },
    ...(variant === undefined ? {} : { variant }),
  }, options);
  if (!response.request.url.endsWith(`/api/session/${encodeURIComponent(sessionID)}/model`)) {
    throw new Error("Session model reassignment requires a direct v2 session model endpoint.");
  }
  if (!response.response.ok) {
    let message = `Failed to update session model (${response.response.status}).`;
    const payload = response.error;
    if (payload && typeof payload === "object") {
      const candidate = "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "error" in payload && typeof payload.error === "object" && payload.error && "message" in payload.error && typeof payload.error.message === "string"
          ? payload.error.message
          : null;
      if (candidate) message = candidate;
    }
    throw new Error(message);
  }
}

export async function shellInSession(
  client: Client,
  sessionID: string,
  command: string,
  options?: { model?: { providerID: string; modelID: string }; agent?: string; variant?: string; messageID?: string },
): Promise<void> {
  const result = await client.session.shell({ sessionID, command, messageID: options?.messageID });
  assertNoClientError(result);
}

export type CommandListItem = {
  id: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
  template?: string;
  hints?: string[];
  agent?: string;
  model?: string;
  subtask?: boolean;
};

export async function listCommands(
  client: Client,
  directory?: string,
): Promise<CommandListItem[]> {
  try {
    const result = await client.command.list({ directory });
    const list = result?.data ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((cmd: Record<string, unknown>) => ({
      id: `cmd:${cmd.name}`,
      name: String(cmd.name ?? ""),
      description: cmd.description ? String(cmd.description) : undefined,
      source: cmd.source as CommandListItem["source"],
      template: typeof cmd.template === "string" ? cmd.template : undefined,
      hints: Array.isArray(cmd.hints)
        ? cmd.hints.filter((hint): hint is string => typeof hint === "string")
        : undefined,
      agent: typeof cmd.agent === "string" ? cmd.agent : undefined,
      model: typeof cmd.model === "string" ? cmd.model : undefined,
      subtask: cmd.subtask === true,
    }));
  } catch {
    return [];
  }
}

function assertNoClientError(result: unknown): void {
  const maybe = result as { error?: unknown } | null | undefined;
  if (!maybe || maybe.error === undefined) return;
  const message =
    maybe.error instanceof Error
      ? maybe.error.message
      : typeof maybe.error === "string"
        ? maybe.error
        : JSON.stringify(maybe.error);
  throw new Error(message || "Unknown error");
}
