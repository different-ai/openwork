import { CLICKY_EXPERIMENT_PREF_KEY } from "../../constants";

export const CLICKY_EXPERIMENT_ENV_VAR = "VITE_OPENWORK_EXPERIMENT_CLICKY";

function isTruthy(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function clickyExperimentForcedByEnv() {
  return isTruthy(
    typeof import.meta.env?.VITE_OPENWORK_EXPERIMENT_CLICKY === "string"
      ? import.meta.env.VITE_OPENWORK_EXPERIMENT_CLICKY
      : null,
  );
}

export function readClickyExperimentPreference() {
  if (typeof window === "undefined") return false;
  try {
    return isTruthy(window.localStorage.getItem(CLICKY_EXPERIMENT_PREF_KEY));
  } catch {
    return false;
  }
}

export function writeClickyExperimentPreference(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLICKY_EXPERIMENT_PREF_KEY, enabled ? "1" : "0");
  } catch {
    // ignore persistence failures
  }
}
