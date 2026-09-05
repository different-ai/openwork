export const DASHBOARD_TILE_CACHE_STORAGE_PREFIX = "openwork.react.dashboardTileCache.v1";

/** Remove every signed-in user's saved dashboard result from this browser profile. */
export function clearDashboardTileCacheStorage(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.`)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
