// Persistent notification center store. Background/system events land here
// (instead of interrupting with toasts) and survive reloads via localStorage.
// Actions are serializable descriptors — not callbacks — so entries can be
// acted on after an app restart. See shell/notifications.ts for the
// notifyEvent/notifyAlert entry points and shell/notification-center.tsx for
// the bell UI.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const PERSISTED_NOTIFICATION_STORE_KEY = "openwork:notifications:v1";

const MAX_NOTIFICATIONS = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export type NotificationKind =
  | "providers"
  | "reload"
  | "cloud"
  | "update"
  | "system";

export type NotificationAction =
  | { type: "open-model-picker"; providerIds: string[] }
  | { type: "reload-engine" };

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  /** How many times this entry was coalesced via dedupeKey. */
  count: number;
  createdAt: number;
  updatedAt: number;
  readAt: number | null;
  /** Unread entries with the same key merge instead of stacking. */
  dedupeKey?: string;
  action?: NotificationAction;
  actionLabel?: string;
};

export type NotificationInput = {
  kind: NotificationKind;
  severity?: NotificationSeverity;
  title: string;
  body?: string;
  dedupeKey?: string;
  action?: NotificationAction;
  actionLabel?: string;
};

type NotificationStore = {
  notifications: AppNotification[];
  add: (input: NotificationInput) => void;
  markAllRead: () => void;
  clearAll: () => void;
};

function prune(notifications: AppNotification[]): AppNotification[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return notifications
    .filter((notification) => notification.updatedAt >= cutoff)
    .slice(0, MAX_NOTIFICATIONS);
}

function createId(now: number): string {
  return `ntf_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const SEVERITIES: NotificationSeverity[] = ["info", "success", "warning", "error"];
const KINDS: NotificationKind[] = ["providers", "reload", "cloud", "update", "system"];

function isSeverity(value: unknown): value is NotificationSeverity {
  return typeof value === "string" && SEVERITIES.some((entry) => entry === value);
}

function isKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && KINDS.some((entry) => entry === value);
}

function isAction(value: unknown): value is NotificationAction {
  if (typeof value !== "object" || value === null) return false;
  const type = Reflect.get(value, "type");
  if (type === "reload-engine") return true;
  if (type === "open-model-picker") {
    const providerIds = Reflect.get(value, "providerIds");
    return Array.isArray(providerIds) && providerIds.every((id) => typeof id === "string");
  }
  return false;
}

/** Rebuild persisted entries defensively so corrupt storage never breaks boot. */
function sanitizeNotifications(value: unknown): AppNotification[] {
  if (!Array.isArray(value)) return [];
  const notifications: AppNotification[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = Reflect.get(entry, "id");
    const kind = Reflect.get(entry, "kind");
    const severity = Reflect.get(entry, "severity");
    const title = Reflect.get(entry, "title");
    const body = Reflect.get(entry, "body");
    const count = Reflect.get(entry, "count");
    const createdAt = Reflect.get(entry, "createdAt");
    const updatedAt = Reflect.get(entry, "updatedAt");
    const readAt = Reflect.get(entry, "readAt");
    const dedupeKey = Reflect.get(entry, "dedupeKey");
    const action = Reflect.get(entry, "action");
    const actionLabel = Reflect.get(entry, "actionLabel");
    if (typeof id !== "string" || typeof title !== "string") continue;
    if (!isKind(kind) || !isSeverity(severity)) continue;
    if (typeof createdAt !== "number" || typeof updatedAt !== "number") continue;
    notifications.push({
      id,
      kind,
      severity,
      title,
      body: typeof body === "string" ? body : undefined,
      count: typeof count === "number" && count > 0 ? count : 1,
      createdAt,
      updatedAt,
      readAt: typeof readAt === "number" ? readAt : null,
      dedupeKey: typeof dedupeKey === "string" ? dedupeKey : undefined,
      action: isAction(action) ? action : undefined,
      actionLabel: typeof actionLabel === "string" ? actionLabel : undefined,
    });
  }
  return notifications;
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set) => ({
      notifications: [],
      add: (input) =>
        set((state) => {
          const now = Date.now();
          if (input.dedupeKey) {
            const existing = state.notifications.find(
              (notification) =>
                notification.dedupeKey === input.dedupeKey && notification.readAt === null,
            );
            if (existing) {
              const merged: AppNotification = {
                ...existing,
                severity: input.severity ?? existing.severity,
                title: input.title,
                body: input.body ?? existing.body,
                action: input.action ?? existing.action,
                actionLabel: input.actionLabel ?? existing.actionLabel,
                count: existing.count + 1,
                updatedAt: now,
              };
              return {
                notifications: prune([
                  merged,
                  ...state.notifications.filter((notification) => notification.id !== existing.id),
                ]),
              };
            }
          }
          const notification: AppNotification = {
            id: createId(now),
            kind: input.kind,
            severity: input.severity ?? "info",
            title: input.title,
            body: input.body,
            count: 1,
            createdAt: now,
            updatedAt: now,
            readAt: null,
            dedupeKey: input.dedupeKey,
            action: input.action,
            actionLabel: input.actionLabel,
          };
          return { notifications: prune([notification, ...state.notifications]) };
        }),
      markAllRead: () =>
        set((state) => {
          if (!state.notifications.some((notification) => notification.readAt === null)) {
            return state;
          }
          const now = Date.now();
          return {
            notifications: state.notifications.map((notification) =>
              notification.readAt === null ? { ...notification, readAt: now } : notification,
            ),
          };
        }),
      clearAll: () => set({ notifications: [] }),
    }),
    {
      name: PERSISTED_NOTIFICATION_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ notifications: state.notifications }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        notifications: prune(
          sanitizeNotifications(
            typeof persistedState === "object" && persistedState !== null
              ? Reflect.get(persistedState, "notifications")
              : null,
          ),
        ),
      }),
    },
  ),
);

export function useUnreadNotificationCount(): number {
  return useNotificationStore((state) =>
    state.notifications.reduce(
      (total, notification) => total + (notification.readAt === null ? 1 : 0),
      0,
    ),
  );
}
