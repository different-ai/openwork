import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import {
  useNotificationStore,
  type NotificationInput,
} from "@/react-app/kernel/notification-store";

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
