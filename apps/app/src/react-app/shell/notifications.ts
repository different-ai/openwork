// Entry points for the notification center.
//
// Delivery classes:
// - notifyEvent: background/system events (cloud sync, reload receipts, …).
//   Center entry + unread badge only — never a popup.
// - notifyAlert: failures that need attention soon. Center entry plus one
//   toast; bursts collapse into a single "N new notifications" summary toast
//   instead of stacking.
//
// Direct feedback for user actions (e.g. "skill installed") should keep using
// `toast` from @/components/ui/sonner and stay out of the center.
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import {
  useNotificationStore,
  type NotificationInput,
} from "@/react-app/kernel/notification-store";
import { notifyDesktopEvent } from "./desktop-notifications";

/** Window event that asks the notification bell to open its panel. */
export const openNotificationCenterEvent = "openwork-open-notification-center";

/** Window event that asks the marketplace view to highlight a plugin. */
export const openMarketplacePluginEvent = "openwork-open-marketplace-plugin";

const PENDING_MARKETPLACE_PLUGIN_KEY = "openwork:pending-marketplace-plugin";

export type OpenMarketplacePluginDetail = {
  pluginName: string;
};

export function openNotificationCenter(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(openNotificationCenterEvent));
}

/** Navigate to the marketplace and pre-fill search with a plugin name. */
export function requestOpenMarketplacePlugin(pluginName: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PENDING_MARKETPLACE_PLUGIN_KEY, pluginName);
  } catch { /* localStorage unavailable */ }
  window.dispatchEvent(
    new CustomEvent<OpenMarketplacePluginDetail>(openMarketplacePluginEvent, {
      detail: { pluginName },
    }),
  );
}

/** Read and clear a pending marketplace plugin name from localStorage. */
export function drainPendingMarketplacePlugin(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(PENDING_MARKETPLACE_PLUGIN_KEY);
    if (value) localStorage.removeItem(PENDING_MARKETPLACE_PLUGIN_KEY);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

export function notifyEvent(input: NotificationInput): void {
  useNotificationStore.getState().add(input);
}

export function notifyScheduledTask(input: {
  workspaceId: string;
  taskId: string;
  runId: string;
  taskName: string;
  status: "completed" | "failed" | "needs-attention";
  detail?: string;
}): void {
  const severity = input.status === "completed" ? "success" : "error";
  const title = input.status === "completed"
    ? t("scheduled_tasks.notification_completed", { name: input.taskName })
    : input.status === "failed"
      ? t("scheduled_tasks.notification_failed", { name: input.taskName })
      : t("scheduled_tasks.notification_attention", { name: input.taskName });
  notifyEvent({
    kind: "scheduled-task",
    severity,
    title,
    body: input.detail,
    dedupeKey: `scheduled-task:${input.taskId}:${input.runId}:${input.status}`,
    action: {
      type: "open-scheduled-task",
      workspaceId: input.workspaceId,
      taskId: input.taskId,
    },
    actionLabel: t("notifications.view"),
  });
  if (input.status === "completed") {
    notifyDesktopEvent({ type: "scheduled-task.completed", taskName: input.taskName });
  } else if (input.status === "failed") {
    notifyDesktopEvent({
      type: "scheduled-task.failed",
      taskName: input.taskName,
      errorText: input.detail,
    });
  } else {
    notifyDesktopEvent({
      type: "scheduled-task.needs-attention",
      taskName: input.taskName,
      detail: input.detail,
    });
  }
}

const ALERT_TOAST_ID = "openwork-notification-alert";
const ALERT_BURST_WINDOW_MS = 8000;

let lastAlertAt = 0;
let alertBurstCount = 0;

type NotifyAlertOptions = {
  /** Optional button on the immediate toast (closures are fine here; the
   *  persistent center entry uses the serializable `action` instead). */
  toastAction?: { label: string; onClick: () => void };
};

export function notifyAlert(input: NotificationInput, options?: NotifyAlertOptions): void {
  useNotificationStore.getState().add({ severity: "error", ...input });

  const now = Date.now();
  if (now - lastAlertAt > ALERT_BURST_WINDOW_MS) {
    alertBurstCount = 0;
  }
  lastAlertAt = now;
  alertBurstCount += 1;

  if (alertBurstCount > 1) {
    toast(t("notifications.summary", { count: alertBurstCount }), {
      id: ALERT_TOAST_ID,
      action: {
        label: t("notifications.view"),
        onClick: openNotificationCenter,
      },
    });
    return;
  }

  const severity = input.severity ?? "error";
  const show =
    severity === "error" ? toast.error : severity === "warning" ? toast.warning : toast.info;
  show(input.title, {
    id: ALERT_TOAST_ID,
    description: input.body,
    action: options?.toastAction,
  });
}
