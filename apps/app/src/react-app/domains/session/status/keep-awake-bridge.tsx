import { useEffect } from "react";

import { desktopBridge } from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/utils";
import { useLocal } from "@/react-app/kernel/local-provider";
import {
  useSessionActivityStore,
  type SessionActivityStatus,
} from "./session-activity-store";

const WORKING_STATUSES: SessionActivityStatus[] = ["thinking", "responding", "compacting"];

export function hasWorkingSession(
  statusesByWorkspaceId: Record<string, Record<string, SessionActivityStatus>>,
): boolean {
  return Object.values(statusesByWorkspaceId).some((sessions) =>
    Object.values(sessions).some((status) => WORKING_STATUSES.includes(status)),
  );
}

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
