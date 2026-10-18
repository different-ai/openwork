/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CalendarConnectionError, type CalendarTransport } from "@openwork/calendar";
import { useMeetingsQuery } from "@openwork/calendar/react";

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() => { if (ownedDom) GlobalRegistrator.register(); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true); });
afterAll(async () => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); if (ownedDom) await GlobalRegistrator.unregister(); });

function Meetings({ transport }: { transport: CalendarTransport }) {
  const read = useMeetingsQuery({ keyPrefix: ["calendar", "member_example"], provider: "google", transport, range: { start: 0, end: 86400000 }, enabled: true });
  return <div><span data-events>{read.data?.events.map(event => event.title).join(",") ?? ""}</span><span data-error>{read.error?.kind ?? ""}</span><span data-success>{String(read.isSuccess)}</span><span data-fetching>{String(read.isFetching)}</span><button onClick={() => void read.refetch()}>Refresh</button></div>;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("The calendar read did not settle");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

test("a blocked calendar read stays masked through a later provider failure until an authorized read", async () => {
  let mode: "allowed" | "denied" | "offline" = "allowed";
  let offlineReads = 0;
  const transport: CalendarTransport = { kind: "mock", google: async () => {
    if (mode === "denied") throw new CalendarConnectionError("google", "policy_blocked", "Blocked by your organization");
    if (mode === "offline") { offlineReads += 1; throw new Error("Provider unavailable"); }
    return [{ id: "event_example", summary: "Project review", description: "", location: "", start: "1970-01-01T01:00:00Z", end: "1970-01-01T02:00:00Z", status: "confirmed", htmlLink: "https://calendar.google.com/", attendees: [], meetLink: null }];
  }, microsoft: async () => [] };
  const queryClient = new QueryClient();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><Meetings transport={transport} /></QueryClientProvider>));
    await until(() => container.querySelector("[data-events]")?.textContent === "Project review");
    mode = "denied";
    await act(async () => container.querySelector("button")?.click());
    await until(() => container.querySelector("[data-error]")?.textContent === "policy_blocked");
    expect(container.querySelector("[data-events]")?.textContent).toBe("");
    expect(container.querySelector("[data-success]")?.textContent).toBe("false");
    mode = "offline";
    await act(async () => container.querySelector("button")?.click());
    await until(() => offlineReads >= 3 && container.querySelector("[data-fetching]")?.textContent === "false");
    expect(container.querySelector("[data-events]")?.textContent).toBe("");
    expect(container.querySelector("[data-error]")?.textContent).toBe("policy_blocked");
    mode = "allowed";
    await act(async () => container.querySelector("button")?.click());
    await until(() => container.querySelector("[data-events]")?.textContent === "Project review");
    expect(container.querySelector("[data-error]")?.textContent).toBe("");
  } finally {
    await act(async () => root.unmount()); container.remove(); queryClient.clear();
  }
}, 15000);
