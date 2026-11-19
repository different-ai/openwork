import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { subscribeProviderCatalogChanges } from "../src/app/lib/provider-events";
import {
  ensureProviderCatalogQuery,
  handleProviderCatalogChange,
  providerCatalogQueryKey,
  providerListQueryKey,
} from "../src/react-app/infra/provider-list-query";

import { liveProviderSyncStatusQueryKey } from "../src/react-app/domains/connections/provider-auth/live-provider-sync";

const baseUrl = "http://localhost:8787/opencode2";
const directory = "/workspace";
const scope = { baseUrl, directory };
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 75));

describe("V2 native provider catalog events", () => {
  for (const type of ["provider.updated", "model.updated", "catalog.updated"]) {
    test(`${type} invalidates the subscribed workspace, including global events`, async () => {
      const changes: Array<{ baseUrl: string; directory?: string }> = [];
      const unsubscribe = subscribeProviderCatalogChanges((value) => changes.push(value));
      const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
        `data: ${JSON.stringify({ type, location: { directory: "/other" } })}\n\n`
        + `data: ${JSON.stringify({ type, location: { directory } })}\n\n`
        + `data: ${JSON.stringify({ type })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
      try {
        const client = createClientV2(baseUrl, directory, {});
        const { stream } = await client.event.subscribe();
        expect(changes).toEqual([{ ...scope, reason: "reconnect" }]);
        changes.length = 0;
        for await (const _event of stream) { /* drain the finite SSE response */ }
        expect(changes).toEqual(type === "catalog.updated"
          ? [scope] // Legacy catalog events still require a matching location.
          : [{ ...scope, reason: "native" }, { ...scope, reason: "native" }]);
      } finally {
        unsubscribe();
        fetch.mockRestore();
      }
    });
  }

  test("every successful reconnect revalidates even when no events were replayed", async () => {
    const changes: Array<{ baseUrl: string; directory?: string }> = [];
    const unsubscribe = subscribeProviderCatalogChanges((value) => changes.push(value));
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(""));
    try {
      const client = createClientV2(baseUrl, directory, {});
      for (let connection = 0; connection < 2; connection += 1) {
        const { stream } = await client.event.subscribe();
        for await (const _event of stream) { /* no replay */ }
      }
      expect(changes).toEqual([{ ...scope, reason: "reconnect" }, { ...scope, reason: "reconnect" }]);
    } finally {
      unsubscribe();
      fetch.mockRestore();
    }
  });

  for (const mode of ["off", "unknown", "v1"]) {
    test(`native/reconnect notifications leave ${mode} behavior unchanged`, async () => {
      const queryClient = new QueryClient();
      const eventScope = mode === "v1" ? { ...scope, baseUrl: "http://localhost:4096" } : scope;
      if (mode !== "unknown") queryClient.setQueryData(liveProviderSyncStatusQueryKey(eventScope.baseUrl), {
        enabled: true, chatRouting: true, liveProviderSync: mode === "v1",
      });
      const invalidate = spyOn(queryClient, "invalidateQueries");
      try {
        handleProviderCatalogChange(queryClient, { ...eventScope, reason: "native" });
        handleProviderCatalogChange(queryClient, { ...eventScope, reason: "reconnect" });
        await pause();
        expect(invalidate).toHaveBeenCalledTimes(0);
        // Legacy catalog.updated still invalidates only connected providers,
        // immediately and without introducing coalescing when the flag is off.
        handleProviderCatalogChange(queryClient, eventScope);
        handleProviderCatalogChange(queryClient, eventScope);
        expect(invalidate).toHaveBeenCalledTimes(2);
        expect(invalidate.mock.calls).toEqual([
          [{ queryKey: providerListQueryKey(eventScope) }],
          [{ queryKey: providerListQueryKey(eventScope) }],
        ]);
      } finally {
        queryClient.clear();
      }
    });
  }

  test("bursts invalidate connected and full catalogs once and only in scope", async () => {
    const queryClient = new QueryClient();
    const other = { ...scope, directory: "/other" };
    for (const key of [providerListQueryKey(scope), providerCatalogQueryKey(scope),
      providerListQueryKey(other), providerCatalogQueryKey(other)]) {
      queryClient.setQueryData(key, { all: [], connected: [], default: {} });
    }
    queryClient.setQueryData(liveProviderSyncStatusQueryKey(baseUrl), {
      enabled: true, chatRouting: true, liveProviderSync: true,
    });
    const invalidate = spyOn(queryClient, "invalidateQueries");
    try {
      for (let i = 0; i < 20; i += 1) handleProviderCatalogChange(queryClient, { ...scope, reason: "native" });
      await pause();
      expect(invalidate).toHaveBeenCalledTimes(2);
      expect(queryClient.getQueryState(providerListQueryKey(scope))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(providerCatalogQueryKey(scope))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(providerListQueryKey(other))?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(providerCatalogQueryKey(other))?.isInvalidated).toBe(false);
      // A later mutation is not suppressed by the previous burst.
      handleProviderCatalogChange(queryClient, { ...scope, reason: "reconnect" });
      await pause();
      expect(invalidate).toHaveBeenCalledTimes(4);
    } finally {
      queryClient.clear();
    }
  });

  test("off keeps the existing full-catalog cache behavior after invalidation", async () => {
    const queryClient = new QueryClient();
    const cached = { all: [], connected: [], default: {} };
    queryClient.setQueryData(providerCatalogQueryKey(scope), cached);
    await queryClient.invalidateQueries({ queryKey: providerCatalogQueryKey(scope) });
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ items: [] }));
    try {
      const client = createClientV2(baseUrl, directory, {});
      expect(await ensureProviderCatalogQuery(queryClient, { ...scope, client })).toEqual(cached);
      expect(fetch).toHaveBeenCalledTimes(0);
    } finally {
      fetch.mockRestore();
      queryClient.clear();
    }
  });

  test("invalidated full catalog is reread on the next provider-picker open", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(providerCatalogQueryKey(scope), { all: [], connected: [], default: {} });
    await queryClient.invalidateQueries({ queryKey: providerCatalogQueryKey(scope) });
    queryClient.setQueryData(liveProviderSyncStatusQueryKey(baseUrl), {
      enabled: true, chatRouting: true, liveProviderSync: true,
    });
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ items: [] }));
    try {
      const client = createClientV2(baseUrl, directory, {});
      await ensureProviderCatalogQuery(queryClient, { ...scope, client });
      // V2 lists models, defaults, and providers to build the compatible catalog.
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(queryClient.getQueryState(providerCatalogQueryKey(scope))?.isInvalidated).toBe(false);
      await ensureProviderCatalogQuery(queryClient, { ...scope, client });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      fetch.mockRestore();
      queryClient.clear();
    }
  });
});
