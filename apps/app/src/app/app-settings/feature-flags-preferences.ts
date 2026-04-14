import { useLocal } from "../context/local";

export function useFeatureFlagsPreferences() {
  const { prefs, setPrefs } = useLocal();

  const microsandboxCreateSandboxEnabled = () =>
    prefs.featureFlags?.microsandboxCreateSandbox === true;

  const toggleMicrosandboxCreateSandbox = () => {
    setPrefs("featureFlags", "microsandboxCreateSandbox", (current) => !current);
  };

  return {
    microsandboxCreateSandboxEnabled,
    toggleMicrosandboxCreateSandbox,
  };
}
