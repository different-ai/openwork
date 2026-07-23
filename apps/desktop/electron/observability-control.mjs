const OBSERVABILITY_LEVELS = new Set(["off", "metadata", "exact"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Resolve the effective Desktop observability level once for every Electron
 * consumer. Environment overrides are authoritative and fail closed: an
 * invalid value never falls through to a less authoritative preference.
 */
export function resolveDesktopObservabilityControl(options = {}, env = process.env) {
  const developerModeRequested = options?.openworkDeveloperMode === true;
  const requested = options?.openworkPromptLog === true;
  const resolved = (level, source) => ({
    developerModeRequested,
    requested,
    enabled: level === "exact",
    consoleEnabled: level !== "off",
    level,
    source,
  });

  const observability = String(env.OPENWORK_OBSERVABILITY ?? "").trim().toLowerCase();
  if (observability) {
    if (OBSERVABILITY_LEVELS.has(observability)) {
      return resolved(observability, "OPENWORK_OBSERVABILITY");
    }
    return resolved("off", "OPENWORK_OBSERVABILITY_INVALID");
  }

  const promptLog = String(env.OPENWORK_PROMPT_LOG ?? "").trim().toLowerCase();
  if (promptLog) {
    if (TRUE_VALUES.has(promptLog)) {
      return resolved("exact", "OPENWORK_PROMPT_LOG");
    }
    if (FALSE_VALUES.has(promptLog)) {
      return resolved("off", "OPENWORK_PROMPT_LOG");
    }
    return resolved("off", "OPENWORK_PROMPT_LOG_INVALID");
  }

  if (requested) return resolved("exact", "desktop-option");
  if (developerModeRequested) return resolved("metadata", "desktop-option");
  return resolved("off", "desktop-option");
}
