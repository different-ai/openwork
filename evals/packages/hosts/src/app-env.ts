/**
 * `pnpm world up ... --env KEY` records the explicitly selected, nonsecret keys
 * in this marker (the CLI already rejects credential-like names). Launchers
 * forward exactly those keys to the app they start, so an app setting such as
 * `OPENWORK_ENGINE_V2_PREVIEW=1` reaches a preview on every placement that can
 * apply it. Without the marker (ordinary eval runs) nothing is forwarded.
 */
export const SELECTED_ENV_KEYS = "OPENWORK_WORLD_SELECTED_ENV_KEYS";

export function selectedEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[SELECTED_ENV_KEYS];
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${SELECTED_ENV_KEYS} marker.`);
  }
  if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === "string")) {
    throw new Error(`Invalid ${SELECTED_ENV_KEYS} marker.`);
  }
  return parsed.filter((key): key is string => typeof key === "string");
}

export function selectedAppEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of selectedEnvKeys(env)) {
    const value = env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}
