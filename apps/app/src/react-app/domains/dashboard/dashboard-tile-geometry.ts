import { createDashboardTileCacheStore } from "@/app/lib/dashboard-cache-storage";

const MAX_GEOMETRY_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_WIDTH_ENTRIES_PER_TILE = 4;
const MAX_ENTRIES_PER_SCOPE = 200;
const MAX_DIMENSION = 10_000;

export type DashboardTileGeometry = {
  workspaceId: string;
  contentWidth: number;
  frameHeight: number;
  outerHeight: number;
  measuredAt: number;
};

type GeometryScope = Map<string, DashboardTileGeometry[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundedWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const width = Math.round(value);
  return width > 0 && width <= MAX_DIMENSION ? width : null;
}

function isFresh(geometry: DashboardTileGeometry, now: number): boolean {
  return geometry.measuredAt <= now && now - geometry.measuredAt <= MAX_GEOMETRY_AGE_MS;
}

function parseGeometry(value: unknown, now: number): DashboardTileGeometry | null {
  if (!isRecord(value) || typeof value.workspaceId !== "string" || !value.workspaceId.trim()) return null;
  const contentWidth = roundedWidth(value.contentWidth);
  if (
    contentWidth === null
    || typeof value.frameHeight !== "number" || !Number.isFinite(value.frameHeight) || value.frameHeight <= 0
    || typeof value.outerHeight !== "number" || !Number.isFinite(value.outerHeight) || value.outerHeight <= 0 || value.outerHeight > MAX_DIMENSION
    || typeof value.measuredAt !== "number" || !Number.isFinite(value.measuredAt) || value.measuredAt <= 0
  ) return null;
  const geometry = {
    workspaceId: value.workspaceId,
    contentWidth,
    frameHeight: Math.max(1, Math.min(800, value.frameHeight)),
    outerHeight: value.outerHeight,
    measuredAt: value.measuredAt,
  };
  return isFresh(geometry, now) ? geometry : null;
}

function pruneScope(scope: GeometryScope, now: number): void {
  const entries = [...scope].flatMap(([entryId, geometries]) => geometries.flatMap((value) => {
    const geometry = parseGeometry(value, now);
    return geometry ? [{ entryId, geometry }] : [];
  })).sort((left, right) => right.geometry.measuredAt - left.geometry.measuredAt);
  scope.clear();
  let count = 0;
  for (const { entryId, geometry } of entries) {
    if (count >= MAX_ENTRIES_PER_SCOPE) break;
    const geometries = scope.get(entryId) ?? [];
    if (geometries.length >= MAX_WIDTH_ENTRIES_PER_TILE) continue;
    if (geometries.some((entry) => entry.workspaceId === geometry.workspaceId && entry.contentWidth === geometry.contentWidth)) continue;
    geometries.push(geometry);
    scope.set(entryId, geometries);
    count += 1;
  }
}

function parseScope(value: unknown, now: number): GeometryScope {
  const scope: GeometryScope = new Map();
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) return scope;
  for (const [entryId, entries] of Object.entries(value.entries)) {
    if (!Array.isArray(entries)) continue;
    const geometries = entries.flatMap((entry: unknown) => {
      const geometry = parseGeometry(entry, now);
      return geometry ? [geometry] : [];
    });
    if (geometries.length > 0) scope.set(entryId, geometries);
  }
  pruneScope(scope, now);
  return scope;
}

const geometryStore = createDashboardTileCacheStore(parseScope, (scope, now) => {
  pruneScope(scope, now);
  return scope.size > 0 ? JSON.stringify({ version: 1, entries: Object.fromEntries(scope) }) : null;
});

export function readDashboardTileGeometry(
  scopeKey: string,
  entryId: string,
  workspaceId: string,
  contentWidth?: number,
): DashboardTileGeometry | null {
  if (!workspaceId.trim()) return null;
  const width = contentWidth === undefined ? undefined : roundedWidth(contentWidth);
  if (width === null) return null;
  const now = Date.now();
  const key = `${scopeKey}.geometry`;
  const scope = geometryStore.read(key, now);
  const geometries = scope?.get(entryId);
  if (!scope || !geometries) return null;
  const fresh = geometries.filter((entry) => isFresh(entry, now));
  if (fresh.length !== geometries.length) {
    if (fresh.length > 0) scope.set(entryId, fresh);
    else scope.delete(entryId);
    geometryStore.schedule(key);
  }
  const geometry = fresh.find((entry) => entry.workspaceId === workspaceId && (width === undefined || entry.contentWidth === width));
  return geometry ? { ...geometry } : null;
}

export function writeDashboardTileGeometry(scopeKey: string, entryId: string, geometry: DashboardTileGeometry): void {
  const now = Date.now();
  const next = parseGeometry(geometry, now);
  if (!next) return;
  const key = `${scopeKey}.geometry`;
  const scope = geometryStore.read(key, now);
  if (!scope) return;
  scope.set(entryId, [next, ...(scope.get(entryId) ?? [])]);
  pruneScope(scope, now);
  geometryStore.schedule(key);
}

export function removeDashboardTileGeometry(scopeKey: string, entryId: string): void {
  const key = `${scopeKey}.geometry`;
  const scope = geometryStore.read(key);
  if (!scope) return;
  scope.delete(entryId);
  geometryStore.schedule(key);
}
