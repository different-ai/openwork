import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { providerListQueryKey, refreshProviderListQueries } from "../src/react-app/infra/provider-list-query";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

test("one provider refresh fetches each observed list once", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let fetches = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: providerListQueryKey({ baseUrl: "http://engine", directory: "/tmp/one" }),
    queryFn: async () => { fetches += 1; return fetches; },
  });
  const unsubscribe = observer.subscribe(() => {});
  cleanups.push(unsubscribe, () => queryClient.clear());
  await observer.refetch();
  const before = fetches;

  await refreshProviderListQueries(queryClient);

  expect(fetches - before).toBe(1);
  expect(observer.getCurrentResult().data).toBe(fetches);
});

test("v2 sends the model, default and provider reads together", async () => {
  const arrived: string[] = [];
  let arrivedBeforeModelsAnswered: string[] = [];
  let releaseModels = () => {};
  const modelsReleased = new Promise<void>((resolve) => { releaseModels = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname.replace(/^\/opencode2/, "");
    arrived.push(path);
    if (arrived.length === 3) releaseModels();
    if (path === "/api/model") {
      // Hold the model read until all three arrive; a serial adapter times out here.
      await Promise.race([modelsReleased, Bun.sleep(500)]);
      arrivedBeforeModelsAnswered = [...arrived];
      return Response.json({ data: [{ id: "model-a", providerID: "acme", name: "Model A" }] });
    }
    if (path === "/api/model/default") return Response.json({ data: {} });
    if (path === "/api/provider") return Response.json({ data: [{ id: "acme", name: "Acme" }] });
    return Response.json({ message: "unexpected" }, { status: 404 });
  } });
  cleanups.push(() => server.stop(true));
  const client = createClientV2(`http://127.0.0.1:${server.port}/opencode2`, "/tmp/one", { token: "fixture" });

  const result = await client.config.providers({ directory: "/tmp/one" });

  expect(arrivedBeforeModelsAnswered.sort()).toEqual(["/api/model", "/api/model/default", "/api/provider"]);
  expect(result.data?.providers.map((provider) => provider.name)).toEqual(["Acme"]);
});
