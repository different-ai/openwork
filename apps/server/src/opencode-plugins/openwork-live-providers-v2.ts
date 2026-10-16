/**
 * AI Gateway providers registered in memory instead of through the engine's
 * config file (see opencode-v2-live-providers.ts on the server).
 *
 * The plugin holds a long read open against the OpenWork server, which
 * answers as soon as its provider list changes, then registers that list with
 * the engine. Nothing here reaches Den: credentials and access come from the
 * server's own provider sync, and the AI Gateway still checks access on every
 * request, so a briefly stale list can never grant a model.
 */

import { gatewayBase, isGatewayQuotaResponse } from "../gateway-quota.js";

type Json = Record<string, unknown>;
type HttpResponse = { model: { providerID: string }; request: Request; response: Response };
type Disposable = { dispose(): Promise<void> };
type ProviderRecord = { info: Json & { id: string }; models: readonly Json[] };
type ProviderEditor = {
  get(providerID: string): unknown;
  add(input: ProviderRecord): void;
  remove(providerID: string): void;
};
export type LiveProvidersContext = {
  options: { url: string; token: string };
  provider: {
    transform(callback: (editor: ProviderEditor) => void): Promise<Disposable>;
    reload(): Promise<void>;
  };
  session: {
    hook(name: "http.response", callback: (event: HttpResponse) => Promise<void>, options: { providerID: string }): Promise<Disposable>;
  };
};

type Snapshot = { revision: number; enabled: boolean; providers: ProviderRecord[] };

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only well-formed records reach the engine: one bad entry would fail its whole model list. */
export function parseLiveProviders(value: unknown): Snapshot | null {
  if (!isRecord(value) || typeof value.revision !== "number" || typeof value.enabled !== "boolean" || !Array.isArray(value.providers)) return null;
  const providers = value.providers.flatMap((entry): ProviderRecord[] => {
    if (!isRecord(entry) || !isRecord(entry.info) || typeof entry.info.id !== "string" || !Array.isArray(entry.models)) return [];
    const models = entry.models.filter((model): model is Json => isRecord(model) && typeof model.id === "string"
      && Array.isArray(model.variants) && isRecord(model.limit) && isRecord(model.capabilities));
    return [{ info: { ...entry.info, id: entry.info.id }, models }];
  });
  return { revision: value.revision, enabled: value.enabled, providers };
}

const WAIT_MS = 25_000;
const FIRST_READ_MS = 2_000;
const MAX_RETRY_MS = 30_000;

export async function registerLiveProviders(context: LiveProvidersContext) {
  let current: Snapshot = { revision: -1, enabled: false, providers: [] };
  let closed = false;
  const controller = new AbortController();
  let registration: Disposable | undefined;
  // Usage-limit answers are final, as the gateway quota plugin does for
  // providers in the config file: the engine must not retry them.
  const quotaHooks = new Map<string, { base: string; hook: Disposable }>();
  const syncQuotaHooks = async (providers: readonly ProviderRecord[]) => {
    const wanted = new Map(providers.flatMap((record) => {
      const settings = isRecord(record.info.settings) ? record.info.settings : {};
      const base = gatewayBase(record.info.id, settings.baseURL);
      return base ? [[record.info.id, base] as const] : [];
    }));
    for (const [id, entry] of quotaHooks) {
      if (wanted.get(id)?.href === entry.base) continue;
      quotaHooks.delete(id);
      await entry.hook.dispose();
    }
    for (const [id, base] of wanted) {
      if (quotaHooks.has(id) || closed) continue;
      const hook = await context.session.hook("http.response", async (event) => {
        if (event.model.providerID !== id || !await isGatewayQuotaResponse(base, new URL(event.request.url), event.response)) return;
        const headers = new Headers(event.response.headers);
        headers.set("x-should-retry", "false");
        event.response = new Response(event.response.body, { status: event.response.status, statusText: event.response.statusText, headers });
      }, { providerID: id });
      quotaHooks.set(id, { base: base.href, hook });
    }
  };

  const read = async (revision: number, waitMs: number, timeoutMs: number): Promise<Snapshot | null> => {
    const response = await fetch(context.options.url, {
      method: "POST", redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_live_providers", input: { revision, waitMs } }),
    });
    if (!response.ok) throw new Error(`OpenWork providers read failed (${response.status})`);
    return parseLiveProviders(await response.json());
  };

  const apply = async (next: Snapshot) => {
    const previous = current;
    current = next;
    await syncQuotaHooks(next.enabled ? next.providers : []);
    if (!registration) {
      if (!next.enabled || next.providers.length === 0) return;
      const created = await context.provider.transform((editor) => {
        // A provider the config file still has (just before it drops it) is replaced, not duplicated.
        for (const record of current.enabled ? current.providers : []) {
          if (editor.get(record.info.id)) editor.remove(record.info.id);
          editor.add(record);
        }
      });
      if (closed) { await created.dispose(); return; }
      registration = created;
      return;
    }
    if (JSON.stringify([previous.enabled, previous.providers]) !== JSON.stringify([next.enabled, next.providers])) {
      await context.provider.reload();
    }
  };

  // The first answer is awaited briefly so models are there for the first
  // prompt; a slow or missing server never blocks the engine for long.
  try {
    const first = await read(current.revision, 0, FIRST_READ_MS);
    if (first) await apply(first);
  } catch {
    // The loop below retries.
  }

  void (async () => {
    let retryMs = 1_000;
    while (!closed) {
      try {
        const next = await read(current.revision, WAIT_MS, WAIT_MS + 10_000);
        if (closed) return;
        if (next && next.revision !== current.revision) await apply(next);
        retryMs = 1_000;
      } catch {
        if (closed) return;
        // Keep serving the last list: the gateway still enforces access.
        await new Promise((resolve) => setTimeout(resolve, retryMs).unref?.());
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      }
    }
  })();

  return async () => {
    closed = true;
    controller.abort();
    const active = registration;
    registration = undefined;
    await active?.dispose();
    for (const { hook } of quotaHooks.values()) await hook.dispose();
    quotaHooks.clear();
  };
}
