import type { Seed } from "@openwork/env";
import type { AutomationList } from "@openwork/types/automations";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/** Real signed-in app-web pages share their production query cache. Only Den read responses are faulted. */
export async function automationsInventory(seed: Seed) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL) throw new Error("Inventory authorization proof requires a cold isolated Den, not a reused organization");
  const { den, webPort } = await denForAppWeb(seed, { web: false, org: { name: "Inventory workspace", admin: { name: "Inventory Admin" } } });
  await enableOrganizationCapabilities(seed, den.admin, { automationCalendar: true });
  const proxy = await seed.faultProxy(den);
  const now = Date.now();
  const item = (index: number): AutomationList["items"][number] => ({
    automation: { id: `automation_${index}`, organizationId: "org_inventory", ownerMemberId: "member_inventory", name: `Inventory brief ${String(index).padStart(3, "0")}`, state: index === 0 ? "active" : "inactive", currentRevisionId: `revision_${index}`, nextDueAt: index === 0 ? now + 1800000 : null, latestRunAt: null, needsAttentionReason: null, createdAt: now - 86400000, updatedAt: now, archivedAt: null },
    revision: { id: `revision_${index}`, automationId: `automation_${index}`, version: 1, instructions: `Summarize project note ${index}`, schedule: { kind: "once", timezone: "UTC", at: now + 1800000 }, model: { providerId: "opencode", modelId: "big-pickle", variant: null }, executionTarget: "desktop", workspaceId: null, maximumRuntimeMs: 900000, digest: "0123456789abcdef0123", createdAt: now - 86400000 },
    latestRun: null,
  });
  const first = { items: Array.from({ length: 100 }, (_, index) => item(index)), nextCursor: "page_100" };
  const next = { items: Array.from({ length: 20 }, (_, index) => item(index + 100)), nextCursor: null };
  const meeting = { ok: true, events: [{ id: "inventory_review", summary: "Inventory team review", description: "", location: "", start: new Date(now + 3600000).toISOString(), end: new Date(now + 7200000).toISOString(), status: "confirmed", htmlLink: "https://calendar.google.com/", attendees: [], meetLink: null }] };
  async function phase(mode: "authorized" | "unavailable" | "denied") {
    await proxy.faults.clear();
    for (const root of ["/api/den/v1", "/v1"]) {
      // Register the longer cursor prefix first; the first-page read always succeeds in these races.
      await proxy.faults.status(`${root}/automations?cursor=page_100`, mode === "authorized" ? 200 : mode === "denied" ? 403 : 503, { times: 1000, method: "GET", body: mode === "authorized" ? next : { error: mode === "denied" ? "access_denied" : "unavailable" } });
      await proxy.faults.status(`${root}/automations?limit=100`, 200, { times: 1000, method: "GET", body: first });
      await proxy.faults.status(`${root}/automation-runs?`, 200, { times: 1000, method: "GET", body: { items: [], nextCursor: null } });
      await proxy.faults.status(`${root}/capabilities/google-workspace/calendar-events`, 200, { times: 1000, method: "GET", body: meeting });
      await proxy.faults.status(`${root}/capabilities/microsoft-365/calendar-events`, 200, { times: 1000, method: "GET", body: { ok: true, events: [] } });
    }
  }
  await phase("authorized");
  const { app, workspace } = await signedInAppWeb(seed, { name: "automations-inventory", den: { ...den, ref: proxy.ref }, webPort, workspacePath: seed.tmpPath("automations-inventory"), env: { VITE_OPENWORK_CALENDAR_MOCK_URL: proxy.ref.apiUrl } });
  return { app, workspace, unavailable: () => phase("unavailable"), deny: () => phase("denied"), authorize: () => phase("authorized"), requests: () => proxy.requestLog() };
}
