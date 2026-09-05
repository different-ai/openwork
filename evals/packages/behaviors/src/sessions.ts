import type { Surface } from "@openwork/cdp";
import { control } from "./desktop.ts";

const FIRST_CREATE_TIMEOUT_MS = 60_000;
const SUBSEQUENT_CREATE_TIMEOUT_MS = 15_000;
const CREATE_ATTEMPT_TIMEOUT_MS = 8_000;
const RENAME_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

export interface SessionSummary {
  sessionId: string;
  title: string;
}

export type SessionControl = (action: string, args?: unknown) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createSession(app: Surface, title: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    let result: unknown;
    try {
      result = await control(app, "session.create_task", undefined, {
        timeoutMs: Math.min(CREATE_ATTEMPT_TIMEOUT_MS, remainingMs),
      });
    } catch (error) {
      lastError = error;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
      continue;
    }

    if (typeof result !== "string" || !result.trim()) {
      throw new Error(`Desktop control action session.create_task returned an invalid session ID for ${JSON.stringify(title)}.`);
    }
    return result.trim();
  }

  throw new Error(
    `Desktop control action session.create_task did not become available for ${JSON.stringify(title)} within ${timeoutMs}ms (${attempts} attempts)${lastError ? `: ${messageText(lastError)}` : ""}.`,
  );
}

function parseSessions(result: unknown): SessionSummary[] {
  if (!Array.isArray(result)) {
    throw new Error(`Desktop control action session.list_sessions returned an invalid list: ${JSON.stringify(result)}`);
  }

  const sessions: SessionSummary[] = [];
  for (const session of result) {
    if (!isRecord(session) || typeof session.sessionId !== "string" || typeof session.title !== "string") {
      throw new Error(`Desktop control action session.list_sessions returned an invalid session: ${JSON.stringify(session)}`);
    }
    sessions.push({ sessionId: session.sessionId, title: session.title });
  }
  return sessions;
}

export async function listSessions(app: Surface): Promise<SessionSummary[]> {
  return parseSessions(await control(app, "session.list_sessions"));
}

async function waitForSessionTitle(
  runControl: SessionControl,
  sessionId: string,
  title: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observed: SessionSummary[] = [];
  let lastError: unknown;

  while (true) {
    try {
      observed = parseSessions(await runControl("session.list_sessions"));
      lastError = undefined;
      if (observed.some((session) => session.sessionId === sessionId && session.title === title)) return;
    } catch (error) {
      lastError = error;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for session ${sessionId} to be renamed to ${JSON.stringify(title)} after ${timeoutMs}ms. Observed: ${JSON.stringify(observed)}${lastError ? `; last error: ${messageText(lastError)}` : ""}.`,
      );
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

export async function renameSessionAndWait(
  runControl: SessionControl,
  sessionId: string,
  title: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? RENAME_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await runControl("session.rename", { sessionId, title });
    try {
      await waitForSessionTitle(runControl, sessionId, title, timeoutMs, intervalMs);
      return;
    } catch (error) {
      if (attempt === 1) {
        throw new Error(`Session rename was not observable after one retry: ${messageText(error)}`);
      }
    }
  }
}

export async function seedSessions(
  app: Surface,
  titles: readonly string[],
): Promise<{ sessionId: string; title: string }[]> {
  const seeded: { sessionId: string; title: string }[] = [];
  for (const [index, title] of titles.entries()) {
    const timeoutMs = index === 0 ? FIRST_CREATE_TIMEOUT_MS : SUBSEQUENT_CREATE_TIMEOUT_MS;
    const sessionId = await createSession(app, title, timeoutMs);
    await renameSessionAndWait((action, args) => control(app, action, args), sessionId, title);
    seeded.push({ sessionId, title });
  }

  const observed = await listSessions(app);
  const missing = titles.filter((title) => !observed.some((session) => session.title === title));
  if (missing.length > 0) {
    throw new Error(
      `Seeded session titles were not present after creation. Missing: ${JSON.stringify(missing)}. Observed: ${JSON.stringify(observed)}.`,
    );
  }
  return seeded;
}
