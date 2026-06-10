/**
 * Typed helpers for OpenCode session operations.
 *
 * The OpenCode SDK (v2) exposes `session.abort`, `session.revert`,
 * `session.unrevert`, `session.shell`, and `command.list` as typed methods.
 * This module provides thin wrappers that avoid `as any` casts by using the
 * SDK types directly, and adds feature-detection for newer API surface
 * (e.g. `shellAsync`) that may not be present in older SDK versions.
 */
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { Client, ModelRef } from "../types";
import { unwrap } from "./opencode";

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/**
 * Abort an active session. Resolves to the server's answer: `true` when a
 * live run was aborted, `false` when nothing matched (already idle, or the
 * session lives in a different project/directory scope). Callers that show
 * "stopped" feedback must check the result — a `200: false` response is NOT
 * a successful stop (#2014).
 *
 * Pass the workspace `directory` whenever the prompt was sent through a
 * directory-scoped client; omitting it can resolve the abort against the
 * server's default project where no matching run exists.
 */
export async function abortSession(
  client: Client,
  sessionID: string,
  directory?: string,
): Promise<boolean> {
  return unwrap(await client.session.abort({ sessionID, directory })) === true;
}

/**
 * Abort an active session, swallowing transport errors (useful before
 * revert/undo). Returns `false` when the abort failed or nothing was
 * aborted, so callers can avoid declaring success on a no-op.
 */
export async function abortSessionSafe(
  client: Client,
  sessionID: string,
  directory?: string,
): Promise<boolean> {
  try {
    return await abortSession(client, sessionID, directory);
  } catch {
    // The session may already be idle or the server unreachable; callers
    // treat `false` as "nothing was aborted".
    return false;
  }
}

/**
 * Revert a session to a specific message boundary.
 */
export async function revertSession(
  client: Client,
  sessionID: string,
  messageID: string,
): Promise<Session> {
  return unwrap(await client.session.revert({ sessionID, messageID })) as Session;
}

/**
 * Fork a session at a specific message, creating a new session branch.
 */
export async function forkSession(
  client: Client,
  sessionID: string,
  messageID?: string,
): Promise<Session> {
  return unwrap(await client.session.fork({ sessionID, messageID })) as Session;
}

/**
 * Restore all previously reverted messages in a session.
 */
export async function unrevertSession(
  client: Client,
  sessionID: string,
): Promise<Session> {
  return unwrap(await client.session.unrevert({ sessionID })) as Session;
}

/**
 * Archive or unarchive a session via OpenCode's native `time.archived` field.
 *
 * Passing `archived: true` stamps the current time; `false` clears it (sends
 * `0`, which the server treats as "not archived"). Archiving is a non-destructive
 * primitive — the session and its context are preserved, which matters for orgs
 * with audit/retention policies that forbid deletion.
 */
export async function setSessionArchived(
  client: Client,
  sessionID: string,
  archived: boolean,
  directory?: string,
): Promise<void> {
  unwrap(
    await client.session.update({
      sessionID,
      directory,
      time: { archived: archived ? Date.now() : 0 },
    }),
  );
}

/**
 * Compact/summarize a long session to reduce context size.
 * Uses `session.summarize` when available and falls back to `/compact` command.
 */
export async function compactSession(
  client: Client,
  sessionID: string,
  model: ModelRef,
  options?: { directory?: string },
): Promise<void> {
  const session = client.session as { summarize?: (input: {
    sessionID: string;
    directory?: string;
    providerID: string;
    modelID: string;
  }) => Promise<unknown> };

  if (typeof session.summarize === "function") {
    const result = await session.summarize({
      sessionID,
      directory: options?.directory,
      providerID: model.providerID,
      modelID: model.modelID,
    });
    assertNoClientError(result);
    return;
  }

  const modelString = `${model.providerID}/${model.modelID}`;
  const result = await client.session.command({
    sessionID,
    command: "compact",
    arguments: "",
    model: modelString,
    directory: options?.directory,
  });
  assertNoClientError(result);
}

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

/**
 * Execute a shell command in a session. Uses `shell` from the SDK.
 * Falls back to `promptAsync` with a `!` prefix if `shell` is unavailable.
 */
export async function shellInSession(
  client: Client,
  sessionID: string,
  command: string,
  options?: { model?: { providerID: string; modelID: string }; agent?: string; variant?: string },
): Promise<void> {
  const result = await client.session.shell({ sessionID, command });
  assertNoClientError(result);
}

// ---------------------------------------------------------------------------
// Command listing
// ---------------------------------------------------------------------------

export type CommandListItem = {
  id: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
};

/**
 * List available slash commands for a workspace.
 */
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
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

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
