export const DEFAULT_POSTHOG_KEY = "phc_4YnPTlDVYPjgwKvLuNxhbHjV5kadgvd7XLzVHWnCXAI";

export function resolvePosthogKey(raw: unknown, isDev: boolean): string {
  if (typeof raw === "string") return raw.trim();
  return isDev ? "" : DEFAULT_POSTHOG_KEY;
}
