import { useLocal } from "../context/local";

type BooleanUpdater = boolean | ((current: boolean) => boolean);

export function useSessionDisplayPreferences() {
  const { prefs, setPrefs } = useLocal();

  const showThinking = () => prefs.showThinking;

  const setShowThinking = (value: BooleanUpdater) => {
    setPrefs("showThinking", (current) =>
      typeof value === "function" ? value(current) : value,
    );
  };

  const toggleShowThinking = () => {
    setShowThinking((current) => !current);
  };

  const resetSessionDisplayPreferences = () => {
    setShowThinking(false);
  };

  return {
    showThinking,
    setShowThinking,
    toggleShowThinking,
    resetSessionDisplayPreferences,
  };
}
