import { listTargets } from "./cdp.ts";
import type { CdpTarget } from "./cdp.ts";

const DEFAULT_CDP_WAIT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanBaseUrl(cdpBaseUrl: string): string {
  let end = cdpBaseUrl.length;
  while (end > 0 && cdpBaseUrl[end - 1] === "/") end -= 1;
  return cdpBaseUrl.slice(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function targetFromUnknown(value: unknown): CdpTarget | null {
  if (!isRecord(value)) return null;
  if (value.type !== "page" || typeof value.webSocketDebuggerUrl !== "string" || !value.webSocketDebuggerUrl) return null;
  return {
    id: stringField(value.id),
    type: "page",
    title: stringField(value.title),
    url: stringField(value.url),
    webSocketDebuggerUrl: value.webSocketDebuggerUrl,
  };
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function firstPageTarget(cdpBaseUrl: string): Promise<CdpTarget> {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return page;
  return newPageTarget(cdpBaseUrl);
}

export async function targetById(cdpBaseUrl: string, targetId: string): Promise<CdpTarget> {
  const targets = await listTargets(cdpBaseUrl);
  const target = targets.find((entry) => entry.id === targetId && entry.type === "page" && entry.webSocketDebuggerUrl);
  if (!target) {
    throw new Error(`No page target ${targetId} available at ${cdpBaseUrl}.`);
  }
  return target;
}

export async function newPageTarget(cdpBaseUrl: string, url = "about:blank"): Promise<CdpTarget> {
  const base = cleanBaseUrl(cdpBaseUrl);
  let response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not create a page target at ${cdpBaseUrl}: ${response.status}`);
  }
  const created = targetFromUnknown(await response.json());
  if (created) return created;
  const targets = await listTargets(cdpBaseUrl);
  const nextPage = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!nextPage) {
    throw new Error(`No page target available at ${cdpBaseUrl}.`);
  }
  return nextPage;
}

export async function activateTarget(cdpBaseUrl: string, targetId: string): Promise<void> {
  if (!targetId) return;
  const base = cleanBaseUrl(cdpBaseUrl);
  await fetch(`${base}/json/activate/${encodeURIComponent(targetId)}`).catch(() => undefined);
}

export async function closeTarget(cdpBaseUrl: string, targetId: string): Promise<void> {
  if (!targetId) return;
  const base = cleanBaseUrl(cdpBaseUrl);
  await fetch(`${base}/json/close/${encodeURIComponent(targetId)}`).catch(() => undefined);
}

export async function waitForCdp(cdpBaseUrl: string, { timeoutMs = DEFAULT_CDP_WAIT_MS }: { timeoutMs?: number } = {}): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await listTargets(cdpBaseUrl);
      return;
    } catch (error) {
      lastError = error;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for CDP at ${cdpBaseUrl}` +
      (lastError ? ` (last error: ${messageText(lastError)})` : ""),
  );
}
