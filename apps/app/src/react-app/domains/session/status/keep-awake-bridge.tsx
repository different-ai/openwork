import { useEffect } from "react";

import { desktopBridge } from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/utils";
import { useLocal } from "@/react-app/kernel/local-provider";
import {
  useSessionActivityStore,
  type SessionActivityStatus,
} from "./session-activity-store";

// A session waiting on a permission or question prompt is not working, so it
// does not keep the computer awake.
const WORKING_STATUSES: SessionActivityStatus[] = ["thinking", "responding", "compacting"];

export function hasWorkingSession(
  statusesByWorkspaceId: Record<string, Record<string, SessionActivityStatus>>,
): boolean {
  return Object.values(statusesByWorkspaceId).some((sessions) =>
    Object.values(sessions).some((status) => WORKING_STATUSES.includes(status)),
  );
}

/**
 * Settings → Preferences → Keep awake: while any session is working, asks the
 * desktop app to stop the computer sleeping, and lets it sleep again when the
 * work finishes or the setting is turned off.
 */
export function KeepAwakeBridge() {
  const { prefs } = useLocal();
  const working = useSessionActivityStore((state) => hasWorkingSession(state.statusesByWorkspaceId));
  const keepAwake = prefs.keepAwake && working;

  useEffect(() => {
    if (!isElectronRuntime()) return;
    void desktopBridge.desktopSetKeepAwake(keepAwake).catch(() => undefined);
  }, [keepAwake]);

  return null;
}
