/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createServer } from "node:http";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AutomationList } from "@openwork/types/automations";
import { createDenClient } from "../src/app/lib/den";
import { useAutomationListQuery, type AutomationsDenContext } from "../src/react-app/domains/automations/use-automations";

const runtimeFetch = globalThis.fetch;
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, fetch: runtimeFetch });
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function item(index: number): AutomationList["items"][number] {
  return {
    automation: { id: `automation_${index}`, organizationId: "org_example", ownerMemberId: "member_example", name: `Brief ${index}`, state: "inactive", currentRevisionId: `revision_${index}`, nextDueAt: null, latestRunAt: null, needsAttentionReason: null, createdAt: 1, updatedAt: 1, archivedAt: null },
    revision: { id: `revision_${index}`, automationId: `automation_${index}`, version: 1, instructions: "Summarize the project", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 }, model: { providerId: "example", modelId: "example", variant: null }, executionTarget: "cloud", workspaceId: null, maximumRuntimeMs: 900000, digest: "0123456789abcdef0123", createdAt: 1 },
    latestRun: null,
  };
}

function Inventory({ context }: { context: AutomationsDenContext }) {
  const list = useAutomationListQuery(context);
  return <div><span data-loaded>{list.data?.items.length ?? 0}</span><span data-complete>{String(list.hasNextPage === false && list.data !== undefined)}</span>{list.isError ? <span>Could not verify more</span> : null}{list.accessDenied ? <span>Access blocked</span> : null}<button onClick={() => void list.fetchNextPage()}>Load more</button><button data-refresh onClick={() => void list.refetch()}>Refresh</button></div>;
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("The paged inventory did not reach the expected state");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

test("a failed continuation preserves the first page and Retry reaches item 101 with its cursor", async () => {
  const requests: string[] = [];
  let nextFailure: 401 | 403 | 503 | null = 503;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    requests.push(url.search);
    response.setHeader("content-type", "application/json");
    if (url.searchParams.has("cursor") && nextFailure !== null) { response.statusCode = nextFailure; response.end(JSON.stringify({ error: "unavailable" })); return; }
    response.end(JSON.stringify(url.searchParams.has("cursor") ? { items: [item(100)], nextCursor: null } : { items: Array.from({ length: 100 }, (_, i) => item(i)), nextCursor: "cursor_100" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing fixture address");
  const context: AutomationsDenContext = { client: createDenClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "fixture-token" }), organizationId: "org_example", ready: true, queryRoot: ["den", "automations", "org_example"] };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><Inventory context={context} /></QueryClientProvider>));
    await until(() => container.querySelector("[data-loaded]")?.textContent === "100");
    expect(container.querySelector("[data-complete]")?.textContent).toBe("false");
    await act(async () => container.querySelector("button")?.click());
    await until(() => container.textContent?.includes("Could not verify more") === true);
    expect(container.querySelector("[data-loaded]")?.textContent).toBe("100");
    nextFailure = null;
    await act(async () => container.querySelector("button")?.click());
    await until(() => container.querySelector("[data-loaded]")?.textContent === "101");
    expect(container.querySelector("[data-complete]")?.textContent).toBe("true");
    expect(requests.filter(value => value.includes("cursor=cursor_100"))).toHaveLength(2);
    for (const status of [401, 403]) {
      const detailKey = [...context.queryRoot, "detail", "automation_0"];
      const meetingKey = [...context.queryRoot, "meetings", "google"];
      queryClient.setQueryDefaults(detailKey, { gcTime: Infinity });
      queryClient.setQueryDefaults(meetingKey, { gcTime: Infinity });
      queryClient.setQueryData(detailKey, { instructions: "Previously authorized instructions" });
      queryClient.setQueryData(meetingKey, { title: "Previously authorized meeting" });
      expect(queryClient.getQueryData(detailKey)).toEqual({ instructions: "Previously authorized instructions" });
      expect(queryClient.getQueryData(meetingKey)).toEqual({ title: "Previously authorized meeting" });
      nextFailure = status === 401 ? 401 : 403;
      await act(async () => container.querySelector<HTMLButtonElement>("[data-refresh]")?.click());
      await until(() => container.textContent?.includes("Access blocked") === true);
      expect(container.querySelector("[data-loaded]")?.textContent).toBe("0");
      expect(queryClient.getQueryData(detailKey)).toBeUndefined();
      expect(queryClient.getQueryData(meetingKey)).toBeUndefined();
      nextFailure = 503;
      await act(async () => container.querySelector<HTMLButtonElement>("[data-refresh]")?.click());
      await until(() => container.textContent?.includes("Could not verify more") === true);
      expect(container.textContent).toContain("Access blocked");
      expect(container.querySelector("[data-loaded]")?.textContent).toBe("0");
      nextFailure = null;
      await act(async () => container.querySelector<HTMLButtonElement>("[data-refresh]")?.click());
      await until(() => container.querySelector("[data-loaded]")?.textContent === "101");
      expect(container.textContent).not.toContain("Access blocked");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    queryClient.clear();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
