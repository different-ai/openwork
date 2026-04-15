export const SERVER_V2_ROLLOUT_FLAG = "OPENWORK_UI_USE_SERVER_V2";
export const SERVER_V2_ROLLOUT_VITE_FLAG = "VITE_OPENWORK_UI_USE_SERVER_V2";

export function parseServerV2Flag(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function readServerV2FlagFromEnv(env?: Record<string, unknown>) {
  const candidate = env?.[SERVER_V2_ROLLOUT_VITE_FLAG];
  return parseServerV2Flag(typeof candidate === "string" ? candidate : null);
}

export function isServerV2Enabled() {
  return readServerV2FlagFromEnv(import.meta.env as Record<string, unknown>);
}
