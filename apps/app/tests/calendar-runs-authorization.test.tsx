/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AutomationRun } from "@openwork/types/automations";
import type { AutomationRunsSource } from "@openwork/calendar";
import { useRunsInRangeQuery } from "@openwork/calendar/react";

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() => { if (ownedDom) GlobalRegistrator.register(); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true); });
afterAll(async () => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); if (ownedDom) await GlobalRegistrator.unregister(); });

function Runs({ source }: { source: AutomationRunsSource }) {
  const read = useRunsInRangeQuery({ keyPrefix: ["calendar", "member_example"], source, range: { start: 0, end: 86400000 }, automations: [], enabled: true });
  return <div><span data-results>{read.data?.runs.map(run => run.resultSummary).join(",") ?? ""}</span><span data-error>{read.error?.message ?? ""}</span><span data-fetching>{String(read.isFetching)}</span><button onClick={() => void read.refetch()}>Refresh</button></div>;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("The range read did not settle");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

test("a denied range read does not expose its cached runs after a later503", async () => {
  const run: AutomationRun = { id: "run_example", automationId: "automation_example", revisionId: "revision_example", trigger: "scheduled", idempotencyKey: "fixture", status: "succeeded", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, attemptCount: 1, executionTarget: "desktop", executionThread: null, providerId: "opencode", modelId: "big-pickle", modelVariant: null, scheduledFor: 1000, startedAt: 1000, finishedAt: 2000, error: null, resultSummary: "Recorded project result", usage: { inputTokens: null, outputTokens: null, costMicros: null }, createdAt: 1000, updatedAt: 2000 };
  let mode: "allowed" | "denied" | "offline" = "allowed";
  let offlineReads = 0;
  const source: AutomationRunsSource = { listRunsInRange: async () => {
    if (mode === "denied") throw Object.assign(new Error("Range access denied"), { status: 403 });
    if (mode === "offline") { offlineReads += 1; throw Object.assign(new Error("Range unavailable"), { status: 503 }); }
    return { items: [run], nextCursor: null };
  }, listRuns: async () => ({ items: [], nextCursor: null }) };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><Runs source={source} /></QueryClientProvider>));
    await until(() => container.querySelector("[data-results]")?.textContent === "Recorded project result");
    mode = "denied";
    await act(async () => container.querySelector("button")?.click());
    await until(() => container.querySelector("[data-error]")?.textContent === "Range access denied");
    expect(container.querySelector("[data-results]")?.textContent).toBe("");
    mode = "offline";
    await act(async () => container.querySelector("button")?.click());
    await until(() => offlineReads > 0 && container.querySelector("[data-fetching]")?.textContent === "false");
    expect(container.querySelector("[data-results]")?.textContent).toBe("");
    expect(container.querySelector("[data-error]")?.textContent).toBe("Range access denied");
    mode = "allowed";
    await act(async () => container.querySelector("button")?.click());
    await until(() => container.querySelector("[data-results]")?.textContent === "Recorded project result");
    expect(container.querySelector("[data-error]")?.textContent).toBe("");
  } finally {
    await act(async () => root.unmount()); container.remove(); queryClient.clear();
  }
});
