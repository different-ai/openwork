export const DEFAULT_POSTHOG_KEY = "phc_4YnPTlDVYPjgwKvLuNxhbHjV5kadgvd7XLzVHWnCXAI";

/**
 * Resolve the PostHog project key. `raw` is VITE_OPENWORK_POSTHOG_KEY.
 * Unset uses the default key in prod builds and stays silent in dev builds.
 * Explicit strings are used after trim; an empty string disables analytics in any build.
 */
export function resolvePosthogKey(raw: unknown, isDev: boolean): string {
  if (typeof raw === "string") return raw.trim(); // explicit value wins; "" disables
  return isDev ? "" : DEFAULT_POSTHOG_KEY;
}
