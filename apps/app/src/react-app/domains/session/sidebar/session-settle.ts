// Settled sessions: finished work that leaves the active lists but stays one
// click away. Settled is derived from activity rather than stored as a flag, so
// a reply, a finished run or an Automation brings a session back on its own.
import { useMemo, useSyncExternalStore } from "react";
import { CheckCheck, Undo2 } from "lucide-react";

import { isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import {
  useSessionManagementStore,
  type SessionSettleEntry,
  type SessionSettleSnapshot,
} from "./session-management-store";
import { isActiveWorkSessionStatus, isNeedsAttentionSessionStatus } from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTLE_CLOCK_MS = 5 * 60 * 1000;

type SessionTimes = {
  id: string;
  parentID?: string | null;
  time?: { created?: number | null; updated?: number | null; archived?: number | null };
};

// Engines report session times in seconds or milliseconds.
const toMs = (raw: number) => raw > 0 && raw < 1_000_000_000_000 ? raw * 1000 : raw;

/** Last activity in milliseconds. */
export function sessionActivityAt(session: SessionTimes): number {
  return toMs(session.time?.updated ?? session.time?.created ?? 0);
}

/** When the session was created, in milliseconds. */
export function sessionCreatedAt(session: SessionTimes): number {
  return toMs(session.time?.created ?? session.time?.updated ?? 0);
}

/** Working sessions and sessions waiting on the person stay in view. */
export const canSettleSessionStatus = (status: string | undefined) =>
  !isActiveWorkSessionStatus(status) && !isNeedsAttentionSessionStatus(status);

export type SessionSettleInput = {
  activityAt: number;
  entry: SessionSettleEntry | undefined;
  status: string | undefined;
  pinned: boolean;
  unread: boolean;
  autoSettleDays: number;
  now: number;
};

/**
 * A manual Settle holds until the session has newer activity. An idle session
 * also settles on its own after `autoSettleDays`, unless it is pinned or has a
 * result nobody has read yet.
 */
export function isSessionSettled(input: SessionSettleInput): boolean {
  if (input.pinned || !canSettleSessionStatus(input.status)) return false;
  const { entry } = input;
  if (entry?.settledThrough !== undefined && input.activityAt <= entry.settledThrough) return true;
  if (input.autoSettleDays <= 0 || input.unread) return false;
  const idleSince = Math.max(input.activityAt, entry?.unsettledAt ?? 0);
  return idleSince > 0 && input.now - idleSince >= input.autoSettleDays * DAY_MS;
}

/**
 * Settling ships for OpenCode v2 only. A workspace qualifies once its server
 * routes chat to the v2 engine; v1 and not-yet-probed workspaces keep today's
 * sidebar.
 */
export function settleWorkspaceIds<T extends { id: string }>(
  workspaces: readonly T[],
  engineBaseUrlFor: (workspace: T) => string | null | undefined,
): Set<string> {
  return new Set(workspaces
    .filter((workspace) => {
      const baseUrl = engineBaseUrlFor(workspace);
      return Boolean(baseUrl && isOpencodeV2BaseUrl(baseUrl));
    })
    .map((workspace) => workspace.id));
}

export type SettledSessionContext = Omit<SessionSettleInput, "activityAt" | "entry" | "status" | "pinned" | "unread"> & {
  settledById: Record<string, SessionSettleEntry>;
  statusById: Record<string, string> | undefined;
  pinnedIds: ReadonlySet<string>;
  unreadIds: ReadonlySet<string>;
};

/** The settled sessions among `sessions`, most recently active first. */
export function filterSettledSessions<T extends SessionTimes>(sessions: readonly T[], context: SettledSessionContext): T[] {
  return sessions
    .filter((session) => isSessionSettled({
      activityAt: sessionActivityAt(session),
      entry: context.settledById[session.id],
      status: context.statusById?.[session.id],
      pinned: context.pinnedIds.has(session.id),
      unread: context.unreadIds.has(session.id),
      autoSettleDays: context.autoSettleDays,
      now: context.now,
    }))
    .sort((a, b) => sessionActivityAt(b) - sessionActivityAt(a));
}

// One shared, slow clock for auto-settle: days-long thresholds do not need
// per-row timers.
let settleNow = Date.now();
const settleClockListeners = new Set<() => void>();
let settleClockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeSettleClock(listener: () => void) {
  settleClockListeners.add(listener);
  if (!settleClockTimer) {
    settleNow = Date.now();
    settleClockTimer = setInterval(() => {
      settleNow = Date.now();
      for (const notify of settleClockListeners) notify();
    }, SETTLE_CLOCK_MS);
  }
  return () => {
    settleClockListeners.delete(listener);
    if (settleClockListeners.size === 0 && settleClockTimer) {
      clearInterval(settleClockTimer);
      settleClockTimer = null;
    }
  };
}

export function useSettleNow(): number {
  return useSyncExternalStore(subscribeSettleClock, () => settleNow, () => settleNow);
}

export type SessionSettleState = {
  settled: boolean;
  /** Settle is offered: the session is idle, not archived and not settled yet. */
  canSettle: boolean;
  toggle: () => void;
};

export function useSessionSettleState(
  session: SessionTimes | null | undefined,
  status: string | undefined,
  title: string,
  /** False outside OpenCode v2 workspaces: no Settle, and nothing counts as settled. */
  enabled: boolean,
): SessionSettleState {
  const sessionId = session?.id ?? "";
  const entry = useSessionManagementStore((state) => state.settledById[sessionId]);
  const pinned = useSessionManagementStore((state) => state.pinnedIds.includes(sessionId));
  const unread = useSessionManagementStore((state) => state.unreadIds.includes(sessionId));
  const autoSettleDays = useSessionManagementStore((state) => state.autoSettleDays);
  const now = useSettleNow();
  return useMemo(() => {
    // Sub-agent sessions never get their own sidebar row, so only root sessions settle.
    if (!enabled || !session || (session.time?.archived ?? 0) > 0 || session.parentID?.trim()) return NOT_SETTLEABLE;
    const activityAt = sessionActivityAt(session);
    const settled = isSessionSettled({ activityAt, entry, status, pinned, unread, autoSettleDays, now });
    return {
      settled,
      canSettle: !settled && canSettleSessionStatus(status),
      toggle: () => {
        if (settled) unsettleSession(session.id, title);
        else if (canSettleSessionStatus(status)) settleSession(session.id, title, activityAt);
      },
    };
  }, [autoSettleDays, enabled, entry, now, pinned, session, status, title, unread]);
}

const NOT_SETTLEABLE: SessionSettleState = { settled: false, canSettle: false, toggle: () => undefined };

export function settleSession(sessionId: string, title: string, activityAt: number) {
  const snapshot = useSessionManagementStore.getState().settle(sessionId, activityAt);
  showSettleUndo(sessionId, t("session_management.session_settled", { title }), true, snapshot);
}

export function unsettleSession(sessionId: string, title: string) {
  const snapshot = useSessionManagementStore.getState().unsettle(sessionId);
  showSettleUndo(sessionId, t("session_management.session_unsettled", { title }), false, snapshot);
}

function showSettleUndo(sessionId: string, message: string, settled: boolean, snapshot: SessionSettleSnapshot) {
  toast.undo(message, {
    id: `session-settle:${sessionId}`,
    icon: settled ? CheckCheck : Undo2,
    undo: {
      label: t("common.undo"),
      onClick: () => useSessionManagementStore.getState().restoreSettle(sessionId, snapshot),
    },
    closeLabel: t("common.close"),
  });
}
