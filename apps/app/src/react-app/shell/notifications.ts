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

/** Window event that asks the notification bell to open its panel. */
export const openNotificationCenterEvent = "openwork-open-notification-center";

export function openNotificationCenter(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(openNotificationCenterEvent));
}

export function notifyEvent(input: NotificationInput): void {
  useNotificationStore.getState().add(input);
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
