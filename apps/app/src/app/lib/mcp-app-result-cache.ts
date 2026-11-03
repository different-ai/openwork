import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAppOrigin } from "../../components/chat/mcp-app-origin";
import type { OpenworkMcpAppResource } from "./openwork-server";
import { createDashboardTileCacheStore, DASHBOARD_TILE_CACHE_STORAGE_PREFIX } from "./dashboard-cache-storage";
import { mcpAppPresentationScope } from "./mcp-app-presentation-cache";

/**
 * An App asks for "read" (this person's last result for a tool and its
 * arguments, answered from storage without calling anything) or "store"
 * (call the tool and keep its result if the server marked it read-only).
 */
export const MCP_APP_CACHE_REQUEST_META = "openwork/cache";
export const MCP_APP_CACHED_RESULT_META = "openwork/cached";
export const MCP_APP_CACHED_AT_META = "openwork/cachedAt";
// Set by the OpenWork server, never by the App or provider: the tool's
// annotations, and a hash of the verified server the result came from.
const READ_ONLY_RESULT_META = "openwork/readOnly";
const PROVIDER_IDENTITY_META = "openwork/providerIdentity";

const STORAGE_KEY = `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.appResults`;
const TTL_MS = 24 * 60 * 60_000;
const MAX_BYTES = 1_000_000;
const MAX_ENTRY_BYTES = 200_000;

type Entry = { cachedAt: number; providerIdentity: string; content: CallToolResult["content"]; structuredContent?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(value: unknown, now: number): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.entries)) return entries;
  for (const item of value.entries) {
    if (!Array.isArray(item) || typeof item[0] !== "string" || !isRecord(item[1])) continue;
    const { cachedAt, providerIdentity, content, structuredContent } = item[1];
    if (typeof cachedAt !== "number" || now - cachedAt > TTL_MS || cachedAt > now || !Array.isArray(content)
      || typeof providerIdentity !== "string") continue;
    entries.set(item[0], {
      cachedAt,
      providerIdentity,
      content: content as CallToolResult["content"],
      ...(isRecord(structuredContent) ? { structuredContent } : {}),
    });
  }
  return entries;
}

// Oldest entries go first once the budget is exceeded; reads move an entry to the end.
function serialize(entries: Map<string, Entry>, now: number): string | null {
  for (const [key, entry] of entries) if (now - entry.cachedAt > TTL_MS) entries.delete(key);
  let raw = JSON.stringify({ v: 1, entries: [...entries] });
  while (raw.length > MAX_BYTES && entries.size > 0) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
    raw = JSON.stringify({ v: 1, entries: [...entries] });
  }
  return entries.size > 0 ? raw : null;
}

const store = createDashboardTileCacheStore(parse, serialize);

/** Arguments with their keys sorted, so the same call has one key however the App spells it. */
export function canonicalMcpAppArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalMcpAppArguments);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalMcpAppArguments(value[key])]));
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One entry per signed-in account and deployment, workspace, App revision,
 * tool and arguments. Nothing is kept while signed out, and the key is a hash.
 */
async function entryKey(origin: McpAppOrigin, app: OpenworkMcpAppResource, name: string, args: Record<string, unknown>) {
  const scope = await mcpAppPresentationScope(origin);
  if (!scope) return null;
  const key = await digest(JSON.stringify([scope.key, origin.workspaceId, app.serverName, app.resourceUri, name, canonicalMcpAppArguments(args)]));
  return { key, current: scope.current };
}

/**
 * This person's last read-only result for the call and the server it came
 * from, or null. Calls no tool; the caller must match the server first.
 */
export async function cachedMcpAppResult(
  origin: McpAppOrigin, app: OpenworkMcpAppResource, name: string, args: Record<string, unknown>,
): Promise<{ providerIdentity: string; result: CallToolResult } | null> {
  try {
    const entry = await entryKey(origin, app, name, args);
    if (!entry || !entry.current()) return null;
    const entries = store.read(STORAGE_KEY);
    const cached = entries?.get(entry.key);
    if (!entries || !cached || Date.now() - cached.cachedAt > TTL_MS) return null;
    return {
      providerIdentity: cached.providerIdentity,
      result: {
        content: cached.content,
        ...(cached.structuredContent ? { structuredContent: cached.structuredContent } : {}),
        _meta: { [MCP_APP_CACHED_RESULT_META]: true, [MCP_APP_CACHED_AT_META]: new Date(cached.cachedAt).toISOString() },
      },
    };
  } catch {
    return null;
  }
}

/** The verified server a result came from, when it may be kept: it succeeded and the OpenWork server marked its tool read-only. */
export function keptMcpAppResultIdentity(result: CallToolResult): string | null {
  const identity = result._meta?.[PROVIDER_IDENTITY_META];
  return !result.isError && result._meta?.[READ_ONLY_RESULT_META] === true && typeof identity === "string" ? identity : null;
}

/** Keeps a successful result only when the OpenWork server marked its tool read-only. */
export async function rememberMcpAppResult(
  origin: McpAppOrigin, app: OpenworkMcpAppResource, name: string, args: Record<string, unknown>, result: CallToolResult,
): Promise<void> {
  try {
    const entry = await entryKey(origin, app, name, args);
    if (!entry) return;
    const entries = store.read(STORAGE_KEY);
    if (!entries) return;
    const providerIdentity = keptMcpAppResultIdentity(result);
    if (!providerIdentity) {
      // A failed or non-read-only answer must not leave an older value behind.
      if (entries.delete(entry.key)) store.schedule(STORAGE_KEY);
      return;
    }
    const kept: Entry = {
      cachedAt: Date.now(),
      providerIdentity,
      content: result.content,
      ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    };
    if (JSON.stringify(kept).length > MAX_ENTRY_BYTES || !entry.current()) return;
    entries.delete(entry.key);
    entries.set(entry.key, kept);
    store.schedule(STORAGE_KEY);
  } catch {
    // Storage is a convenience; the call's result is unaffected.
  }
}

/** Drops a kept result, e.g. when its call is no longer allowed. */
export async function forgetMcpAppResult(
  origin: McpAppOrigin, app: OpenworkMcpAppResource, name: string, args: Record<string, unknown>,
): Promise<void> {
  try {
    const entry = await entryKey(origin, app, name, args);
    const entries = entry ? store.read(STORAGE_KEY) : null;
    if (entry && entries?.delete(entry.key)) store.schedule(STORAGE_KEY);
  } catch {
    // Storage is a convenience.
  }
}
