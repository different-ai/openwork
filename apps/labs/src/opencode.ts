import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { LabsWorkspace, NormalizedLabsEvent } from "./types";

const REQUEST_TIMEOUT_MS = 12_000;

function stripTrailingSlash(input: string) {
  return input.replace(/\/+$/, "");
}

function withInferredProtocol(input: string) {
  if (/^[a-z]+:\/\//i.test(input)) return input;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(input)) {
    return `http://${input}`;
  }
  return `https://${input}`;
}

export function normalizeOpencodeBaseUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(withInferredProtocol(trimmed));
    if (/^localhost$/i.test(url.hostname)) {
      url.hostname = "127.0.0.1";
    }
    const path = stripTrailingSlash(url.pathname || "");
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(url.hostname);
    const isWorkspaceProxy = path.startsWith("/w/");
    if (isLocal) {
      url.pathname = isWorkspaceProxy ? path : "";
    } else {
      url.pathname = isWorkspaceProxy || path.endsWith("/opencode") ? path : `${path || ""}/opencode`;
    }
    return stripTrailingSlash(url.toString());
  } catch {
    return "";
  }
}

export function workspaceNameFromUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const label = url.hostname.replace(/^www\./, "").split(".")[0] ?? "";
    return label
      .split(/[-_]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  } catch {
    return "";
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: init?.signal ?? controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createLabsClient(workspace: LabsWorkspace) {
  const baseUrl = normalizeOpencodeBaseUrl(workspace.baseUrl);
  const headers = workspace.token?.trim()
    ? {
        Authorization: `Bearer ${workspace.token.trim()}`,
      }
    : undefined;

  return createOpencodeClient({
    baseUrl,
    headers,
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetchWithTimeout(globalThis.fetch, input, init),
  });
}

export function unwrap<T>(result: unknown): T {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if ("data" in record) {
      if (record.data !== undefined) return record.data as T;
      throw new Error(describeError(record.error));
    }
  }

  return result as T;
}

export function normalizeLabsEvent(raw: unknown): NormalizedLabsEvent | null {
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  if (typeof record.type === "string") {
    return {
      type: record.type,
      properties: record.properties,
    };
  }

  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return {
        type: payload.type,
        properties: payload.properties,
      };
    }
  }

  return null;
}
