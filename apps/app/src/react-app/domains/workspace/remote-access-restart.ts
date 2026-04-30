import { useCallback, useState } from "react";

import { openworkServerRestart, type OpenworkServerInfo } from "../../../app/lib/desktop";
import {
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
} from "../../../app/lib/openwork-server";
import { t } from "../../../i18n";

export type RemoteAccessRestartPhase =
  | "idle"
  | "restarting"
  | "reconnecting"
  | "failed";

type UseRemoteAccessRestartOptions = {
  isEnabled: () => boolean;
  onHostInfo: (info: OpenworkServerInfo) => void;
  onSettingsChanged: () => void;
};

export function useRemoteAccessRestart(options: UseRemoteAccessRestartOptions) {
  const [phase, setPhase] = useState<RemoteAccessRestartPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (enabled: boolean) => {
      if (phase === "restarting" || phase === "reconnecting") return;

      const previous = readOpenworkServerSettings();
      const next = { ...previous, remoteAccessEnabled: enabled };

      setPhase("restarting");
      setError(null);
      writeOpenworkServerSettings(next);
      options.onSettingsChanged();

      try {
        const info = await openworkServerRestart({ remoteAccessEnabled: enabled });
        options.onHostInfo(info);
        setPhase("idle");
      } catch (caught) {
        writeOpenworkServerSettings(previous);
        options.onSettingsChanged();
        setError(caught instanceof Error ? caught.message : t("app.error_remote_access"));
        setPhase("failed");
      }
    },
    [options, phase],
  );

  const reset = useCallback(() => {
    if (phase === "failed") {
      setPhase("idle");
      setError(null);
    }
  }, [phase]);

  return {
    busy: phase === "restarting" || phase === "reconnecting",
    error,
    phase,
    reset,
    save,
    status: statusForPhase(phase, options.isEnabled()),
  };
}

function statusForPhase(phase: RemoteAccessRestartPhase, enabled: boolean) {
  switch (phase) {
    case "restarting":
      return "Restarting worker…";
    case "reconnecting":
      return "Reconnecting to worker…";
    case "failed":
      return enabled
        ? "Remote access may still be on. Check connection details or retry."
        : "Remote access is still off. You can retry when ready.";
    default:
      return enabled
        ? "Remote access is currently enabled."
        : "Remote access is currently disabled.";
  }
}
