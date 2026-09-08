import { useCallback } from "react";

import { useLocal } from "../../../kernel/local-provider";

export function useFeatureFlagsPreferences() {
  const { prefs, setPrefs } = useLocal();

  const workspaceRunModeEnabled = prefs.featureFlags?.workspaceRunMode === true;
  const toggleWorkspaceRunMode = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        workspaceRunMode: !previous.featureFlags?.workspaceRunMode,
      },
    }));
  }, [setPrefs]);

  const microsandboxCreateSandboxEnabled =
    prefs.featureFlags?.microsandboxCreateSandbox === true;

  const toggleMicrosandboxCreateSandbox = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        microsandboxCreateSandbox: !previous.featureFlags?.microsandboxCreateSandbox,
      },
    }));
  }, [setPrefs]);

  return {
    workspaceRunModeEnabled,
    toggleWorkspaceRunMode,
    microsandboxCreateSandboxEnabled,
    toggleMicrosandboxCreateSandbox,
  };
}
