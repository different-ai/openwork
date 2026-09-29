import { join } from "node:path";
import { continueLegacyThread, createLegacyHistoryService, LegacyHistoryError } from "@openwork/opencode-legacy-threads/service";
import { opencodeV1DatabasePath } from "./opencode-v2-migration.js";
import { runtimeStorageDir } from "./runtime-db.js";
import { createV2SessionHomes } from "./opencode-v2-session-home.js";
import type { ServerConfig } from "./types.js";
import { loopbackFetch } from "./server-fetch.js";
import { ApiError } from "./errors.js";

/** V1 source selection happens in the owning host, outside v2's environment. */
export function createOpenworkLegacyHistory(config: ServerConfig) {
  // Resolve lazily so a missing or unsupported source never prevents v2 startup.
  const service = () => createLegacyHistoryService({ legacyDatabase: opencodeV1DatabasePath(),
    targetDatabase: join(runtimeStorageDir(config), "opencode-v2", "state", "opencode.db") });
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof LegacyHistoryError) throw new ApiError(error.status, error.code, error.message);
      throw new ApiError(422, "legacy_history_unavailable", "V1 history could not be read or converted. Refresh the chat and try again; the original is unchanged.");
    }
  }
  return {
    list: (directory: string, limit?: number, before?: string, search?: string) => guarded(() => service().list({ directory, limit, before, search })),
    read: (directory: string, reference: string, limit?: number, before?: string, messageID?: string) => guarded(() => service().read({ directory, reference, limit, before, messageID })),
    prepare: (directory: string, reference: string) => guarded(() => service().prepareImport({ directory, reference })),
    children: (directory: string, reference: string) => guarded(async () => {
      const reader = service();
      const rows = []; let before: string | undefined;
      do {
        const page = await reader.list({ directory, parentReference: reference, limit: 200, before });
        rows.push(...page.data); before = page.nextCursor ?? undefined;
      } while (before);
      return rows;
    }),
    continue: (directory: string, reference: string, connection: { url: string; username: string; password: string }, allowOmissions: boolean) => guarded(async () => {
      const target = { fetchJson: async (path: string, init?: { directory?: string; method?: string; body?: unknown; timeoutMs?: number }) => {
        const url = new URL(path, connection.url);
        url.searchParams.set("location[directory]", init?.directory ?? directory);
        const response = await loopbackFetch(url.toString(), { method: init?.method ?? "GET",
          headers: { authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`, "content-type": "application/json" },
          ...(init?.body ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000) });
        return { status: response.status, json: await response.json() };
      } };
      const plan = await service().prepareImport({ directory, reference });
      const homes = createV2SessionHomes(config, async path => {
        const response = await target.fetchJson(path, { directory });
        if (response.status !== 200) throw new Error("Native session could not be read");
        return response.json;
      });
      return continueLegacyThread(plan, {
        key: runtimeStorageDir(config),
        get: async id => {
          const response = await target.fetchJson(`/api/session/${encodeURIComponent(id)}`, { directory });
          if (response.status === 404) return null;
          if (response.status !== 200) throw new Error("Native session could not be read");
          // Do not adopt a same-ID session owned by a different workspace.
          if (await homes.resolve(response.json) !== await homes.canonical(directory)) {
            throw new LegacyHistoryError("legacy_conflict", "A v2 chat already uses this ID in another workspace.", 409);
          }
          return response.json;
        },
        import: async payload => {
          const response = await target.fetchJson("/api/session/import", { method: "POST", directory,
            body: payload, timeoutMs: 30_000 });
          if (response.status !== 200) throw new LegacyHistoryError("legacy_import_failed", `V2 could not import this chat (${response.status}). Retry to continue the remaining chats.`, response.status === 409 ? 409 : 502);
          return response.json;
        },
        onImported: (id, home) => homes.remember(id, home),
      }, { allowOmissions });
    }),
  };
}
