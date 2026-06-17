export const CLOUD_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Minimum spacing between window-focus / visibility cloud-provider syncs so
 * rapid blur/focus cycles don't refetch the Den provider list repeatedly.
 * The in-flight guard and the provider-auth store's sync queue dedup
 * concurrent runs on top of this.
 */
export const CLOUD_FOCUS_SYNC_MIN_INTERVAL_MS = 15 * 1000;
