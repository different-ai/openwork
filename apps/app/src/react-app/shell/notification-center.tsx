/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  CircleCheck,
  Info,
  OctagonX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import {
  useNotificationStore,
  type AppNotification,
  type NotificationSeverity,
} from "@/react-app/kernel/notification-store";
import { requestOpenModelPicker } from "./new-providers-listener";
import { openNotificationCenterEvent } from "./notifications";
import { useReloadCoordinator } from "./reload-coordinator";
import { useShellConfig } from "./shell-config";

const SEVERITY_ICONS: Record<NotificationSeverity, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: OctagonX,
};

const SEVERITY_CLASSES: Record<NotificationSeverity, string> = {
  info: "text-sky-11",
  success: "text-emerald-11",
  warning: "text-amber-11",
  error: "text-red-11",
};

function formatTimeAgo(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return t("notifications.just_now");
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Notification bell with unread badge + popover panel. Mounted in the
 * session and settings headers; hidden via the `notifications` shell flag.
 * Closing the panel marks everything read.
 */
export function NotificationBell() {
  const { config } = useShellConfig();
  const [open, setOpen] = useState(false);
  const notifications = useNotificationStore((state) => state.notifications);
  const markAllRead = useNotificationStore((state) => state.markAllRead);
  const clearAll = useNotificationStore((state) => state.clearAll);
  const reloadCoordinator = useReloadCoordinator();

  const unreadCount = useMemo(
    () => notifications.filter((notification) => notification.readAt === null).length,
    [notifications],
  );

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(openNotificationCenterEvent, handler);
    return () => window.removeEventListener(openNotificationCenterEvent, handler);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) markAllRead();
    },
    [markAllRead],
  );

  const runAction = useCallback(
    (notification: AppNotification) => {
      const action = notification.action;
      if (!action) return;
      setOpen(false);
      markAllRead();
      if (action.type === "open-model-picker") {
        requestOpenModelPicker(action.providerIds);
      } else if (action.type === "reload-engine") {
        void reloadCoordinator.reloadWorkspaceEngine();
      }
    },
    [markAllRead, reloadCoordinator],
  );

  if (!config.notifications) return null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-xl text-gray-10 transition-colors hover:bg-muted hover:text-foreground"
            title={t("notifications.title")}
            aria-label={
              unreadCount > 0
                ? `${t("notifications.title")} (${unreadCount})`
                : t("notifications.title")
            }
          >
            <Bell size={17} />
            {unreadCount > 0 ? (
              <span className="absolute right-0.5 top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-3 text-primary-foreground">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : null}
          </Button>
        }
      />
      <PopoverContent align="end" sideOffset={8} className="w-96 gap-0 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="text-sm font-semibold">{t("notifications.title")}</p>
          {notifications.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={clearAll}
            >
              {t("notifications.clear_all")}
            </Button>
          ) : null}
        </div>
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
            <Bell className="mb-2 size-5 text-muted-foreground/60" />
            <p className="text-sm font-medium">{t("notifications.empty")}</p>
            <p className="text-xs text-muted-foreground">{t("notifications.empty_hint")}</p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto py-1">
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onAction={runAction}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function NotificationRow({
  notification,
  onAction,
}: {
  notification: AppNotification;
  onAction: (notification: AppNotification) => void;
}) {
  const Icon = SEVERITY_ICONS[notification.severity];
  const unread = notification.readAt === null;
  const showCount =
    notification.count > 1 &&
    (notification.severity === "warning" || notification.severity === "error");

  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3",
        unread ? "bg-primary/5" : "opacity-80",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", SEVERITY_CLASSES[notification.severity])} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium">
            {notification.title}
            {showCount ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                ×{notification.count}
              </span>
            ) : null}
          </p>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {formatTimeAgo(notification.updatedAt)}
            {unread ? <span className="size-1.5 rounded-full bg-primary" /> : null}
          </span>
        </div>
        {notification.body ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{notification.body}</p>
        ) : null}
        {notification.action && notification.actionLabel ? (
          <div className="mt-1.5">
            <Button variant="outline" size="sm" onClick={() => onAction(notification)}>
              {notification.actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
