function promptLogEnabled(options) {
  return options?.openworkPromptLog === true;
}

function developerModeEnabled(options) {
  return options?.openworkDeveloperMode === true;
}

function failedBootstrap(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Serialize desktop runtime bootstrap attempts and reconcile the renderer's
 * persisted Developer Mode preference with the eager main-process bootstrap.
 *
 * Electron starts the runtime while the window is loading, before renderer
 * localStorage is available. The renderer then calls runtimeBootstrap with
 * the stored preference. A changed preference must schedule one follow-up
 * bootstrap so the runtime manager restarts the managed engine with the right
 * observability environment instead of returning the stale eager promise.
 */
export function createRuntimeBootstrapCoordinator(boot) {
  let bootstrapPromise = null;
  let scheduledObservabilityKey = null;

  return function ensureRuntimeBootstrap(options = {}) {
    const requestedPromptLogEnabled = promptLogEnabled(options);
    const requestedDeveloperModeEnabled = developerModeEnabled(options);
    const observabilityKey = `${requestedDeveloperModeEnabled}:${requestedPromptLogEnabled}`;
    const normalizedOptions = {
      ...options,
      openworkDeveloperMode: requestedDeveloperModeEnabled,
      openworkPromptLog: requestedPromptLogEnabled,
    };

    if (!bootstrapPromise) {
      scheduledObservabilityKey = observabilityKey;
      bootstrapPromise = Promise.resolve()
        .then(() => boot(normalizedOptions))
        .catch(failedBootstrap);
      return bootstrapPromise;
    }

    if (scheduledObservabilityKey === observabilityKey) {
      return bootstrapPromise;
    }

    scheduledObservabilityKey = observabilityKey;
    bootstrapPromise = bootstrapPromise
      .then(() => boot(normalizedOptions))
      .catch(failedBootstrap);
    return bootstrapPromise;
  };
}
