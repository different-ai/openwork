import { sessionActivityFrom } from "./opencode-plugins/session-activity.js";
import { isRecord } from "./workspace-kv-store.js";

type Read = (path: string) => Promise<unknown>;
function data(value: unknown): unknown { return isRecord(value) && "data" in value ? value.data : value; }
function items(value: unknown): Record<string, unknown>[] {
  const rows = data(value);
  if (!Array.isArray(rows)) throw new Error("Invalid engine list response");
  return rows.filter(isRecord);
}
function session(value: unknown) {
  const row = data(value);
  if (!isRecord(row)) throw new Error("Invalid engine session response");
  const info = isRecord(row.info) ? row.info : row;
  const home = info.openworkHomeDirectory;
  return { ...info, directory: home ?? (isRecord(info.location) ? info.location.directory : undefined) };
}
async function pages(read: Read, path: string, limit?: number): Promise<Record<string, unknown>[]> {
  const url = new URL(path, "http://engine");
  url.searchParams.set("limit", String(limit ?? 200));
  const rows: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  while (true) {
    const result = await read(url.pathname + url.search);
    rows.push(...items(result));
    const next = isRecord(result) && isRecord(result.cursor) ? result.cursor.next : undefined;
    if (limit !== undefined || typeof next !== "string" || !next) return rows;
    if (cursors.has(next)) throw new Error("Invalid engine pagination cursor");
    cursors.add(next);
    url.searchParams.set("cursor", next);
  }
}

/** Adapt read-only native endpoints to the existing semantic query contract.
 * Calls go through OpenWork's native proxy, which checks stable session homes. */
export function createV2ReadAdapter(read: Read): Read {
  return async path => {
    const match = /^\/workspace\/([^/]+)\/opencode(\/.*)$/.exec(path);
    if (!match) return read(path);
    const base = `/workspace/${match[1]}/opencode2`;
    const native: Read = path => read(base + path);
    const url = new URL(match[2], "http://engine");
    if (url.pathname === "/session/status") {
      const active = data(await native("/api/session/active"));
      if (!isRecord(active)) throw new Error("Invalid engine activity response");
      return Object.fromEntries(Object.entries(active).map(([id, value]) => [id,
        { type: isRecord(value) && value.type === "running" ? "busy" : "idle" }]));
    }
    if (url.pathname === "/session") {
      const rows = await pages(native, "/api/session");
      return rows.filter(row => url.searchParams.get("roots") !== "true" || !row.parentID).map(session);
    }
    if (url.pathname === "/provider") {
      const [models, providers] = await Promise.all([native("/api/model").then(items), native("/api/provider").then(items)]);
      const names = new Map(providers.map(provider => [provider.id, provider.name]));
      const catalog = new Map<string, { id: string; name: string; models: Record<string, { name: string }> }>();
      for (const model of models) {
        if (typeof model.id !== "string" || typeof model.providerID !== "string") continue;
        const name = names.get(model.providerID);
        const provider = catalog.get(model.providerID) ?? {
          id: model.providerID, name: typeof name === "string" ? name : model.providerID, models: {},
        };
        provider.models[model.id] = { name: typeof model.name === "string" ? model.name : model.id };
        catalog.set(model.providerID, provider);
      }
      return { all: [...catalog.values()], connected: [...catalog.keys()] };
    }
    if (url.pathname === "/question") return items(await native("/api/form/request"));
    const target = /^\/session\/([^/]+)(\/message|\/children)?$/.exec(url.pathname);
    if (!target) throw new Error("Unsupported native engine read");
    if (!target[2]) return session(await native(`/api/session/${target[1]}`));
    if (target[2] === "/children") {
      return (await pages(native, "/api/session")).filter(row => row.parentID === decodeURIComponent(target[1])).map(session);
    }
    const limit = url.searchParams.get("limit");
    const rows = await pages(native, `/api/session/${target[1]}/message`, limit === null ? undefined : Number(limit));
    return rows.filter(row => row.type === "user" || row.type === "assistant")
      .sort((a, b) => Number(isRecord(a.time) ? a.time.created : 0) - Number(isRecord(b.time) ? b.time.created : 0))
      .map(row => ({ info: { id: row.id, role: row.type, time: row.time, ...(row.error ? { error: row.error } : {}) },
        parts: Array.isArray(row.content) ? row.content.filter(part => isRecord(part) && part.type === "text") : typeof row.text === "string" ? [{ type: "text", text: row.text }] : [] }));
  };
}

export async function readV2SessionActivity(read: Read, workspaceId: string, sessionId: string) {
  const base = `/workspace/${encodeURIComponent(workspaceId)}/opencode2`;
  const native: Read = path => read(base + path);
  const [listed, statuses] = await Promise.all([
    pages(native, "/api/session").catch(() => null),
    native("/api/session/active").then(data).catch(() => null),
  ]);
  const ids = new Set([sessionId]);
  if (listed) {
    for (let changed = true; changed;) {
      changed = false;
      for (const row of listed) {
        if (typeof row.id !== "string" || typeof row.parentID !== "string" || !ids.has(row.parentID) || ids.has(row.id)) continue;
        ids.add(row.id); changed = true;
      }
    }
  }
  const permissions: Record<string, unknown>[] = [];
  const questions: Record<string, unknown>[] = [];
  let complete = listed !== null;
  const pending = [...ids];
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    for (let id = pending.shift(); id; id = pending.shift()) {
      try {
        const [p, q] = await Promise.all([
          native(`/api/session/${encodeURIComponent(id)}/permission`),
          native(`/api/session/${encodeURIComponent(id)}/form`),
        ]);
        permissions.push(...items(p).map(item => ({ ...item, sessionID: id })));
        questions.push(...items(q).map(item => ({ ...item, sessionID: id })));
      } catch { complete = false; }
    }
  }));
  return sessionActivityFrom(statuses, complete ? permissions : null, complete ? questions : null,
    sessionId, [...ids].filter(id => id !== sessionId), listed ? 0 : 1);
}
