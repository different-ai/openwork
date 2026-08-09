import { useCallback } from "react";

import { useLocal } from "../../../kernel/local-provider";

export function useFeatureFlagsPreferences() {
  const { prefs, setPrefs } = useLocal();

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

  const memoryEnabled = prefs.featureFlags?.memory === true;

  const toggleMemory = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        memory: !previous.featureFlags?.memory,
      },
    }));
  }, [setPrefs]);

  return {
    microsandboxCreateSandboxEnabled,
    toggleMicrosandboxCreateSandbox,
    memoryEnabled,
    toggleMemory,
  };
}
