import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { formatRelative, formatShare, formatUsd } from "../components/admin/free-auto-usage/format";
import {
  organizationsCsv,
  parseFreeAutoUsageReport,
  selectOrganizations,
  type FreeAutoOrganizationUsage,
  type FreeAutoUsageReport,
} from "../components/admin/free-auto-usage/free-auto-usage-data";

const now = "2026-10-01T12:00:00.000Z";
function organization(overrides: Partial<FreeAutoOrganizationUsage>): FreeAutoOrganizationUsage {
  return {
    id: "org-a", name: "Acme", slug: "acme", enrolled: true, subscribed: false, memberCount: 4, activePeople: 2, peopleAtWeeklyLimit: 0,
    lastUsedAt: "2026-10-01T11:00:00.000Z", costMicroUsd: 1_500_000, requests: 30, estimatedRequests: 1, inputTokens: 40_000, outputTokens: 6_000, ...overrides,
  };
}
function report(overrides: Partial<FreeAutoUsageReport> = {}): FreeAutoUsageReport {
  return {
    generatedAt: now,
    range: { days: 30, from: "2026-09-02T00:00:00.000Z", to: now, timezone: "UTC" },
    settings: { membersEnabled: true, rolloutAllOrganizations: false, weeklyLimitMicroUsd: 5_000_000 },
    totals: { costMicroUsd: 2_750_000, requests: 50, estimatedRequests: 3, inputTokens: 60_000, outputTokens: 9_000, activePeople: 3, activeOrganizations: 2 },
    members: { costMicroUsd: 2_500_000, requests: 40, estimatedRequests: 2, inputTokens: 55_000, outputTokens: 8_000, activePeople: 3 },
    guests: { costMicroUsd: 250_000, requests: 10, estimatedRequests: 1, inputTokens: 5_000, outputTokens: 1_000 },
    week: { startsAt: "2026-09-28T00:00:00.000Z", endsAt: "2026-10-05T00:00:00.000Z", activePeople: 3, peopleAtWeeklyLimit: 1 },
    daily: [
      { date: "2026-09-30", membersMicroUsd: 1_000_000, guestsMicroUsd: 100_000, requests: 20 },
      { date: "2026-10-01", membersMicroUsd: 1_500_000, guestsMicroUsd: 150_000, requests: 30 },
    ],
    organizations: [
      organization({}),
      organization({ id: "org-b", name: "Beta, Inc.", slug: "beta", enrolled: false, subscribed: true, activePeople: 1, peopleAtWeeklyLimit: 1, costMicroUsd: 1_000_000, requests: 10, estimatedRequests: 1, lastUsedAt: "2026-09-30T12:00:00.000Z" }),
      organization({ id: "org-c", name: "Quiet pilot", slug: "quiet", activePeople: 0, costMicroUsd: 0, requests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: null }),
    ],
    otherOrganizations: null,
    ...overrides,
  };
}

test("formatting keeps small spend visible and reads empty wholes as a dash", () => {
  expect(formatUsd(1_234_567)).toBe("$1.23");
  expect(formatUsd(4_900)).toBe("$0.0049");
  expect(formatUsd(0)).toBe("$0.00");
  expect(formatShare(0, 0)).toBe("—");
  expect(formatShare(1, 400)).toBe("<1%");
  expect(formatShare(3, 50)).toBe("6%");
  expect(formatRelative(null)).toBe("Never");
  expect(formatRelative("2026-10-01T11:00:00.000Z", Date.parse(now))).toBe("1 h ago");
  expect(formatRelative("2026-09-30T12:00:00.000Z", Date.parse(now))).toBe("Yesterday");
});

test("organizations filter by search and enrollment and sort by any measure", () => {
  const rows = report().organizations;
  expect(selectOrganizations(rows, { search: "", sort: "spend", enrolledOnly: false }).map((row) => row.id)).toEqual(["org-a", "org-b", "org-c"]);
  expect(selectOrganizations(rows, { search: "", sort: "limit", enrolledOnly: false })[0]?.id).toBe("org-b");
  expect(selectOrganizations(rows, { search: "", sort: "recent", enrolledOnly: false }).map((row) => row.id)).toEqual(["org-a", "org-b", "org-c"]);
  expect(selectOrganizations(rows, { search: "", sort: "spend", enrolledOnly: true }).map((row) => row.id)).toEqual(["org-a", "org-c"]);
  expect(selectOrganizations(rows, { search: "BETA", sort: "spend", enrolledOnly: false }).map((row) => row.id)).toEqual(["org-b"]);
});

test("the CSV export quotes names and reports spend in dollars", () => {
  const lines = organizationsCsv(report()).trim().split("\n");
  expect(lines[0]).toStartWith("organization_id,name,enrolled");
  expect(lines[2]).toContain('"Beta, Inc."');
  expect(lines[1]).toContain(",1.500000,");
});

test("the page refuses a partial report instead of showing half-understood numbers", () => {
  expect(parseFreeAutoUsageReport(report())).not.toBeNull();
  expect(parseFreeAutoUsageReport({ ...report(), guests: { requests: 1 } })).toBeNull();
  expect(parseFreeAutoUsageReport({ ...report(), organizations: [{ id: "x" }] })).toBeNull();
  expect(parseFreeAutoUsageReport({ ...report(), daily: [{ date: "2026-10-01", membersMicroUsd: -1, guestsMicroUsd: 0, requests: 0 }] })).toBeNull();
});

async function renderPage(reply: (days: string | null) => { status?: number; payload: unknown }) {
  GlobalRegistrator.register({ url: "https://den.example.test/admin/free-auto" });
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const requested: Array<string | null> = [];
  const request = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (url.pathname.replace(/^\/api\/browser/, "") !== "/v1/admin/free-auto/usage") throw new Error(`Unexpected request: ${url.pathname}`);
    requested.push(url.searchParams.get("days"));
    const { status = 200, payload } = reply(url.searchParams.get("days"));
    return new Response(JSON.stringify(payload), { status });
  });
  const { createRoot } = await import("react-dom/client");
  const { FreeAutoUsagePage } = await import("../components/admin/free-auto-usage/free-auto-usage-page");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
  await act(async () => root.render(<FreeAutoUsagePage />));
  await flush();
  return {
    container, requested, flush,
    async cleanup() {
      await act(async () => root.unmount());
      request.mockRestore();
      container.remove();
      await GlobalRegistrator.unregister();
      if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
      else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    },
  };
}

test("the page shows platform totals, every organization and guest totals, and reloads for a new range", async () => {
  const page = await renderPage(() => ({ payload: report() }));
  try {
    const text = page.container.textContent ?? "";
    expect(page.requested).toEqual(["30"]);
    expect(text).toContain("Free spend$2.75");
    expect(text).toContain("Members $2.50 · Guests $0.25");
    expect(text).toContain("6% charged the estimate");
    expect(text).toContain("At weekly limit1of 3 active this week");
    expect(text).toContain("Rollout: 2 enrolled");
    const rows = [...page.container.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Acme");
    expect(rows[1]).toContain("Pays for Models");
    expect(rows[1]).toContain("1 person");
    expect(rows[2]).toContain("Never");
    const enrolled = [...page.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === "Enrolled");
    await act(async () => enrolled?.click());
    expect(page.container.querySelectorAll("tbody tr")).toHaveLength(2);
    const week = [...page.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === "7 days");
    await act(async () => week?.click());
    await page.flush();
    expect(page.requested).toEqual(["30", "7"]);
  } finally {
    await page.cleanup();
  }
});

test("non-admins see why the page is empty, and a broken report shows an error instead of numbers", async () => {
  const forbidden = await renderPage(() => ({ status: 403, payload: { error: "forbidden" } }));
  try {
    expect(forbidden.container.textContent).toContain("not on the OpenWork admin allowlist");
    expect(forbidden.container.querySelector("tbody")).toBeNull();
  } finally {
    await forbidden.cleanup();
  }
  const broken = await renderPage(() => ({ payload: { ...report(), totals: null } }));
  try {
    expect(broken.container.textContent).toContain("does not understand");
    expect(broken.container.querySelector("tbody")).toBeNull();
  } finally {
    await broken.cleanup();
  }
});
