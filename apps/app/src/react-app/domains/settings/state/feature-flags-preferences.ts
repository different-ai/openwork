import { useCallback } from "react";

import { useLocal } from "../../../kernel/local-provider";

export function useFeatureFlagsPreferences() {
  const { prefs, setPrefs } = useLocal();

  const microsandboxCreateSandboxEnabled =
    prefs.featureFlags?.microsandboxCreateSandbox === true;
  const realtimeControlEnabled = prefs.featureFlags?.realtimeControl === true;

  const toggleMicrosandboxCreateSandbox = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        microsandboxCreateSandbox: !previous.featureFlags?.microsandboxCreateSandbox,
      },
    }));
  }, [setPrefs]);

  const toggleRealtimeControl = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        realtimeControl: !previous.featureFlags?.realtimeControl,
      },
    }));
  }, [setPrefs]);

  return {
    microsandboxCreateSandboxEnabled,
    toggleMicrosandboxCreateSandbox,
    realtimeControlEnabled,
    toggleRealtimeControl,
  };
}
