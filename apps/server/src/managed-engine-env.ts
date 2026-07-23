export type ManagedEngineEnvInput = {
  sourceEnv: NodeJS.ProcessEnv;
  serverUrl: string;
  serverToken: string;
  runtimeConfigPath: string;
  opencodeModelsUrl?: string;
  /** Visible desktop Developer Mode preference; controls prompt observability only. */
  developerModeEnabled?: boolean;
  /** Separate exact-content consent nested under desktop Developer Mode. */
  promptLogEnabled?: boolean;
};

/** Snapshot only the non-secret controls used to decide prompt diagnostics. */
export function buildPromptDebugControlEnv(
  sourceEnv: NodeJS.ProcessEnv,
  developerModeEnabled?: boolean,
  promptLogEnabled?: boolean,
): NodeJS.ProcessEnv {
  const desktopDevMode = developerModeEnabled === undefined
    ? sourceEnv.OPENWORK_DESKTOP_DEV_MODE
    : developerModeEnabled ? "1" : "0";
  const desktopPromptLog = promptLogEnabled === undefined
    ? sourceEnv.OPENWORK_DESKTOP_PROMPT_LOG
    : promptLogEnabled ? "1" : "0";
  return {
    ...(sourceEnv.OPENWORK_OBSERVABILITY === undefined
      ? {}
      : { OPENWORK_OBSERVABILITY: sourceEnv.OPENWORK_OBSERVABILITY }),
    ...(sourceEnv.OPENWORK_PROMPT_LOG === undefined
      ? {}
      : { OPENWORK_PROMPT_LOG: sourceEnv.OPENWORK_PROMPT_LOG }),
    ...(desktopDevMode === undefined
      ? {}
      : { OPENWORK_DESKTOP_DEV_MODE: desktopDevMode }),
    ...(desktopPromptLog === undefined
      ? {}
      : { OPENWORK_DESKTOP_PROMPT_LOG: desktopPromptLog }),
    ...(sourceEnv.OPENWORK_DEV_MODE === undefined
      ? {}
      : { OPENWORK_DEV_MODE: sourceEnv.OPENWORK_DEV_MODE }),
  };
}

/**
 * Build the OpenWork-owned environment injected into a managed OpenCode process.
 * The caller supplies the source environment so this helper stays pure.
 */
export function buildManagedEngineEnv(
  input: ManagedEngineEnvInput,
): Record<string, string> {
  const devMode = input.sourceEnv.OPENWORK_DEV_MODE;
  const promptDebugEnv = buildPromptDebugControlEnv(
    input.sourceEnv,
    input.developerModeEnabled,
    input.promptLogEnabled,
  );
  const observability = promptDebugEnv.OPENWORK_OBSERVABILITY;
  const promptLog = promptDebugEnv.OPENWORK_PROMPT_LOG;
  const desktopDevMode = promptDebugEnv.OPENWORK_DESKTOP_DEV_MODE;
  const desktopPromptLog = promptDebugEnv.OPENWORK_DESKTOP_PROMPT_LOG;
  const uiControlDiscovery = input.sourceEnv.OPENWORK_UI_CONTROL_DISCOVERY;
  const forwardedEnv = {
    ...(devMode ? { OPENWORK_DEV_MODE: devMode } : {}),
    ...(uiControlDiscovery
      ? { OPENWORK_UI_CONTROL_DISCOVERY: uiControlDiscovery }
      : {}),
  };
  return {
    ...forwardedEnv,
    // Preserve the operator's actual control source/value so initialization
    // records can distinguish an explicit override from desktop dev mode.
    ...(observability === undefined ? {} : { OPENWORK_OBSERVABILITY: observability }),
    ...(promptLog === undefined ? {} : { OPENWORK_PROMPT_LOG: promptLog }),
    ...(desktopDevMode === undefined
      ? {}
      : { OPENWORK_DESKTOP_DEV_MODE: desktopDevMode }),
    ...(desktopPromptLog === undefined
      ? {}
      : { OPENWORK_DESKTOP_PROMPT_LOG: desktopPromptLog }),
    OPENWORK_SERVER_URL: input.serverUrl,
    OPENWORK_SERVER_TOKEN: input.serverToken,
    OPENCODE_CONFIG: input.runtimeConfigPath,
    ...(input.opencodeModelsUrl === undefined
      ? {}
      : { OPENCODE_MODELS_URL: input.opencodeModelsUrl }),
  };
}
