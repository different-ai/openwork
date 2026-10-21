import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ContextUsageControl } = await import("../src/react-app/domains/session/surface/composer/context-usage-control");
type Usage = import("../src/react-app/domains/session/surface/composer/context-usage").ContextUsage;
type Breakdown = import("../src/react-app/domains/session/surface/composer/context-breakdown").ContextBreakdown;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const BASIS_KEY = "openwork.contextUsage.basis.v1";
const mounted: Array<() => Promise<void>> = [];
// Clean up even when an assertion failed: a leftover open popover would leak into the next test.
afterEach(async () => {
  while (mounted.length) await mounted.pop()?.();
  document.body.innerHTML = "";
  window.localStorage.removeItem(BASIS_KEY);
});

const usage = (extra: Partial<Usage> = {}): Usage => ({
  used: 34_000,
  window: 100_000,
  percent: 34,
  ceiling: 92_000,
  tone: "neutral",
  hint: null,
  ...extra,
});

async function mount(value: Usage, breakdown?: { load: () => Promise<Breakdown> }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const source = breakdown ? { queryKey: ["breakdown-test", Math.random()] as const, load: breakdown.load } : undefined;
  const element = createElement(QueryClientProvider, { client }, createElement(ContextUsageControl, { usage: value, breakdown: source }));
  await act(async () => { root.render(element); });
  mounted.push(async () => { await act(async () => root.unmount()); client.clear(); });
  const trigger = host.querySelector<HTMLElement>("[data-testid=composer-context-trigger]");
  const open = async () => {
    await act(async () => { trigger?.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  };
  return { host, trigger, open };
}

const details = () => document.querySelector("[data-testid=composer-context-details]");

test("shows the share of the window", async () => {
  const view = await mount(usage());
  expect(view.trigger?.textContent).toContain("Context: 34%");
  expect(view.trigger?.getAttribute("data-tone")).toBe("neutral");
  expect(view.trigger?.getAttribute("aria-label")).toBe("Context: 34%, 34k of 100k tokens");
});

test("shows tokens instead of a percentage when the window is unknown", async () => {
  const view = await mount(usage({ window: null, percent: null, ceiling: null, used: 12_300 }));
  expect(view.trigger?.textContent).toContain("Context: 12.3k");
  expect(view.trigger?.textContent).not.toContain("%");
  expect(view.trigger?.getAttribute("aria-label")).toBe("Context: 12.3k, 12.3k tokens");
});

test("marks the colour step on the trigger and keeps it in text", async () => {
  const warning = await mount(usage({ used: 75_000, percent: 75, tone: "warning" }));
  expect(warning.trigger?.getAttribute("data-tone")).toBe("warning");
  expect(warning.trigger?.className).toContain("text-amber-11");
  const strong = await mount(usage({ used: 88_000, percent: 88, tone: "strong", hint: "soon" }));
  expect(strong.trigger?.getAttribute("data-tone")).toBe("strong");
  expect(strong.trigger?.className).toContain("text-amber-12");
});

test("opens details with the numbers, and the compaction hint only when there is one", async () => {
  const quiet = await mount(usage());
  await quiet.open();
  expect(details()?.textContent).toContain("34k of 100k tokens");
  expect(details()?.textContent).not.toContain("Auto-compaction");
});

test("says compaction is near in the strong step, and nothing about \"the next reply\"", async () => {
  const near = await mount(usage({ used: 88_000, percent: 88, tone: "strong", hint: "soon" }));
  await near.open();
  expect(details()?.textContent).toContain("Auto-compaction soon");
  expect(details()?.textContent).not.toContain("next reply");
});


// ---- breakdown -------------------------------------------------------------

const breakdown = (): Breakdown => ({
  used: 50_000,
  window: 100_000,
  scaled: false,
  rows: [
    { id: "messages", tokens: 25_000, estimated: true },
    { id: "tools", tokens: 5_000, estimated: true, partial: true },
    { id: "system", tokens: 20_000, estimated: true },
    { id: "buffer", tokens: 8_000, estimated: false },
    { id: "free", tokens: 42_000, estimated: false },
  ],
});

const rowCells = () => [...document.querySelectorAll("[data-testid=composer-context-rows] li")].map((li) => {
  const spans = [...li.children].filter((child) => child.tagName === "SPAN").map((span) => span.textContent ?? "");
  return { id: li.getAttribute("data-row"), label: spans[1], tokens: spans[2], share: spans[3] };
});

const half = usage({ used: 50_000, percent: 50 });

test("lists the categories with tokens and shares of the window, estimates marked", async () => {
  const view = await mount(half, { load: async () => breakdown() });
  await view.open();
  const rows = rowCells();
  expect(rows.map((row) => row.id)).toEqual(["messages", "tools", "system", "buffer", "free"]);
  expect(rows[0]).toMatchObject({ label: "Messages", tokens: "≈25k", share: "25.0%" });
  expect(rows[1]).toMatchObject({ label: "Toolspartial", tokens: "≈5k", share: "5.0%" });
  expect(rows[3]).toMatchObject({ label: "Auto-compaction buffer", tokens: "8k", share: "8.0%" });
  expect(rows[4]).toMatchObject({ label: "Free space", tokens: "42k", share: "42.0%" });
  expect(document.querySelector("[data-testid=composer-context-rows]")?.getAttribute("data-basis")).toBe("window");
});

test("switches to shares of the occupied context, which drops the buffer and free space, and remembers the choice", async () => {
  const view = await mount(half, { load: async () => breakdown() });
  await view.open();
  await act(async () => { document.querySelector<HTMLElement>("button[data-basis=occupied]")?.click(); });
  const rows = rowCells();
  expect(rows.map((row) => row.id)).toEqual(["messages", "tools", "system"]);
  expect(rows.map((row) => row.share)).toEqual(["50.0%", "10.0%", "40.0%"]);
  expect(window.localStorage.getItem(BASIS_KEY)).toBe("occupied");
});

test("starts in the remembered basis", async () => {
  window.localStorage.setItem(BASIS_KEY, "occupied");
  const view = await mount(half, { load: async () => breakdown() });
  await view.open();
  expect(document.querySelector("[data-testid=composer-context-rows]")?.getAttribute("data-basis")).toBe("occupied");
});

test("outlines the dot of free space, which has the colour of the empty track, and no other dot", async () => {
  const view = await mount(half, { load: async () => breakdown() });
  await view.open();
  const dot = (id: string) => document.querySelector(`[data-testid=composer-context-rows] li[data-row=${id}] span`)?.className ?? "";
  expect(dot("free")).toContain("ring-1");
  for (const id of ["messages", "tools", "system", "buffer"]) expect(dot(id)).not.toContain("ring-1");
});

test("keeps the layout while loading", async () => {
  const view = await mount(half, { load: () => new Promise<Breakdown>(() => {}) });
  await view.open();
  expect(document.querySelector("[data-testid=composer-context-loading]")).not.toBeNull();
  expect(document.querySelector("[data-testid=composer-context-rows]")).toBeNull();
});

test("says so when the breakdown cannot be built, and still shows the measured total", async () => {
  const view = await mount(half, { load: async () => { throw new Error("offline"); } });
  await view.open();
  expect(details()?.textContent).toContain("Breakdown unavailable");
  expect(details()?.textContent).toContain("50k of 100k tokens");
});

test("offers no basis switch and no window rows when the window is unknown", async () => {
  const noWindow: Breakdown = { used: 12_000, window: null, scaled: false, rows: [{ id: "messages", tokens: 2_000, estimated: true }, { id: "system", tokens: 10_000, estimated: true }] };
  const view = await mount(usage({ used: 12_000, window: null, percent: null, ceiling: null }), { load: async () => noWindow });
  await view.open();
  expect(document.querySelector("button[data-basis=occupied]")).toBeNull();
  expect(rowCells().map((row) => row.share)).toEqual(["16.7%", "83.3%"]);
});

test("says the total is measured and the rows are estimates", async () => {
  const view = await mount(half, { load: async () => breakdown() });
  await view.open();
  expect(details()?.textContent).toContain("The total is measured by the model provider");
});
