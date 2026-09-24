import { DASHBOARD_TILE_CACHE_STORAGE_PREFIX } from "../src/app/lib/dashboard-cache-storage";
import { expect, mock, test } from "bun:test";
import type { GeneratedArtifactView, GeneratedArtifactViewRevision, SavedAppDetail } from "@openwork/types/workflows";
import { isLiveGeneratedApp, liveGeneratedAppCacheScope, liveGeneratedAppEntry, loadSavedAppForDisplay, nextViewerDayBoundary, viewerLocalDate } from "../src/react-app/domains/apps/live-generated-app-model";
import { DASHBOARD_AUTO_REFRESH_INTERVAL_MS, dashboardTileRunsAutomatically, shouldAutoRefreshDashboardTile } from "../src/react-app/domains/dashboard/dashboard-tile-cache";

const revision: GeneratedArtifactViewRevision = {
  id: "avr_fixture", artifactViewId: "arv_fixture", resourceUri: "ui://openwork/artifacts/arv_fixture/avr_fixture",
  buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "output",
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
  compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 10,
  retiredAt: null, createdAt: "2026-09-14T00:00:00.000Z",
};
const view: GeneratedArtifactView = {
  id: "arv_fixture", configObjectId: "cob_fixture", title: "Today", description: null,
  status: "active", activeRevisionId: revision.id, revisions: [revision],
  createdAt: revision.createdAt, updatedAt: revision.createdAt,
};
const snapshot: SavedAppDetail = {
  view, workflowTitle: "Today", canManage: true, onDashboard: true,
  revision, html: "<p>Snapshot</p>", payload: null, previewNotice: null,
};

test("live tools carry the viewer time zone and retain the exact saved resource binding", () => {
  const entry = liveGeneratedAppEntry(view, revision, "America/Los_Angeles");
  expect(entry.toolName).toBe("run_artifact_arv_fixture");
  expect(entry.projectedToolName).toBe("openwork-cloud_run_artifact_arv_fixture");
  expect(entry.resourceUri).toBe(revision.resourceUri);
  expect(entry.launchArguments).toEqual({ timeZone: "America/Los_Angeles" });
  expect(dashboardTileRunsAutomatically(false, entry.autoLaunch === true, false, false)).toBe(true);
  expect(DASHBOARD_AUTO_REFRESH_INTERVAL_MS).toBe(300_000);
  expect(shouldAutoRefreshDashboardTile({ visible: true, refreshing: false, lastRefreshAt: 1, now: 300_001 })).toBe(true);
  expect(shouldAutoRefreshDashboardTile({ visible: true, refreshing: true, lastRefreshAt: 1, now: 300_001 })).toBe(false);
});

test("caller, organization, host, revision and time zone cannot share live cache identities", () => {
  const scopes = [["host", "one", "org"], ["host", "two", "org"], ["host", "one", "other"], ["other", "one", "org"], ["host", "one", "org", "api"]];
  expect(new Set(scopes.map(liveGeneratedAppCacheScope)).size).toBe(scopes.length);
  expect(liveGeneratedAppCacheScope(scopes[0]).startsWith(`${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.`)).toBe(true);
  const entry = liveGeneratedAppEntry(view, revision, "UTC");
  expect(liveGeneratedAppEntry(view, revision, "Asia/Tokyo").id).not.toBe(entry.id);
  expect(liveGeneratedAppEntry(view, { ...revision, resourceUri: `${revision.resourceUri}/new` }, "UTC").id).not.toBe(entry.id);
});

test.each([undefined, "snapshot"])("legacy and explicit snapshot modes retain receipt lookup (%s)", async (dataMode) => {
  const saved = { ...snapshot, view: { ...view, dataMode } };
  const client = { listSavedApps: mock(async () => ({ items: [saved] })), getSavedApp: mock(async () => snapshot) };
  expect(isLiveGeneratedApp(saved.view)).toBe(false);
  const options = { receiptId: "receipt_fixture", revisionId: revision.id };
  expect(await loadSavedAppForDisplay(client, "org", view.id, options)).toBe(snapshot);
  expect(client.getSavedApp).toHaveBeenCalledWith("org", view.id, options);
});

test("live detail lookup uses shared metadata and never runs the REST snapshot preview", async () => {
  const saved = { ...snapshot, view: { ...view, dataMode: "live" } };
  const client = { listSavedApps: mock(async () => ({ items: [saved] })), getSavedApp: mock(async () => snapshot) };
  const result = await loadSavedAppForDisplay(client, "org", view.id, {});
  expect(isLiveGeneratedApp(result.view)).toBe(true);
  expect(result.revision).toEqual(revision);
  expect(result.payload).toBeNull();
  expect(result.html).toBeNull();
  expect(client.getSavedApp).not.toHaveBeenCalled();
});

test("an explicit unsaved revision still opens the draft preview", async () => {
  const saved = { ...snapshot, view: { ...view, dataMode: "live" } };
  const client = { listSavedApps: mock(async () => ({ items: [saved] })), getSavedApp: mock(async () => snapshot) };
  const options = { revisionId: "avr_draft" };
  expect(await loadSavedAppForDisplay(client, "org", view.id, options)).toBe(snapshot);
  expect(client.getSavedApp).toHaveBeenCalledWith("org", view.id, options);
});

test.each([
  ["America/Los_Angeles", "2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z"],
  ["America/Los_Angeles", "2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z"],
  ["Asia/Kathmandu", "2026-09-14T12:00:00Z", "2026-09-14T18:15:00Z"],
])("viewer midnight honors DST and fractional offsets (%s)", (zone, start, end) => {
  const boundary = nextViewerDayBoundary(zone, Date.parse(start));
  expect(boundary).toBe(Date.parse(end));
  expect(viewerLocalDate(zone, boundary - 1)).not.toBe(viewerLocalDate(zone, boundary));
  expect(liveGeneratedAppEntry(view, revision, zone, boundary - 1).id).not.toBe(liveGeneratedAppEntry(view, revision, zone, boundary).id);
  expect(liveGeneratedAppEntry(view, revision, zone, Date.parse(start)).id).toBe(liveGeneratedAppEntry(view, revision, zone, boundary - 1).id);
});

test("exact live draft forwards the viewer zone without substituting the active revision", async () => {
  const saved = { ...snapshot, view: { ...view, dataMode: "live" } };
  const client = { listSavedApps: mock(async () => ({ items: [saved] })), getSavedApp: mock(async () => snapshot) };
  const options = { revisionId: "avr_draft", timeZone: "Asia/Tokyo" };
  await loadSavedAppForDisplay(client, "org", view.id, options);
  expect(client.getSavedApp).toHaveBeenCalledWith("org", view.id, options);
});
