import { afterEach, expect, test } from "bun:test";
import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
afterEach(() => { Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch }); });

test("saved app REST preview serializes exact revision, receipt and IANA time zone", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/apps/arv_fixture");
    expect(Object.fromEntries(url.searchParams)).toEqual({ revisionId: "avr_draft", receiptId: "receipt_fixture", timeZone: "America/Los_Angeles" });
    return Response.json({
      view: { id: "arv_fixture", configObjectId: "cob_fixture", title: "Today", description: null,
        status: "active", activeRevisionId: null, revisions: [], createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z" },
      workflowTitle: "Today", canManage: true, onDashboard: false, revision: null,
      html: null, payload: null, previewNotice: "Connect your calendar",
      runError: { connectionCard: { connectionId: "emc_fixture" } },
    });
  } });
  const client = createDenClient({ baseUrl: "https://den.example.test", apiBaseUrl: "https://api.den.example.test", token: "fixture" });
  const result = await client.getSavedApp("org_fixture", "arv_fixture", { revisionId: "avr_draft", receiptId: "receipt_fixture", timeZone: "America/Los_Angeles" });
  expect(result.runError).toEqual({ connectionCard: { connectionId: "emc_fixture" } });
});
