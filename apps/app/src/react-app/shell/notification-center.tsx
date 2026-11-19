/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { ActivityEmpty } from "@/react-app/domains/activity/activity-empty";
import { ActivityRow } from "@/react-app/domains/activity/activity-row";
import { ActivityCaughtUp, ActivityLoading, ActivityNothingShared, ActivityRefreshError } from "@/react-app/domains/activity/activity-status";
import { useActivityFeed, type ActivityFeedItem } from "@/react-app/domains/activity/use-activity-feed";
import { useActivityStore } from "@/react-app/kernel/activity-store";
import { useNotificationStore } from "@/react-app/kernel/notification-store";
import { useControlAction, type OpenworkControlAction } from "./control/control-provider";
import { openNotificationCenterEvent } from "./notifications";
import { useShellConfig } from "./shell-config";

/** Shared Activity entry point. Closing it marks entries seen; it never changes the history itself. */
export function NotificationBell({ align = "end" }: { align?: "start" | "end" }) {
  const { config } = useShellConfig();
  const [open, setOpen] = useState(false);
  const notifications = useNotificationStore((state) => state.notifications);
  const { items, context, refreshState, loading, now, unreadCount, nothingSharedYet } = useActivityFeed(open && config.notifications);
  const markSeen = useActivityStore((state) => state.markSeen);
  const onActivityPage = useLocation().pathname === "/activity";
  const navigate = useNavigate();

  const notificationsListAction = useMemo<OpenworkControlAction>(() => ({
    id: "notifications.list",
    label: "List notifications",
    description: "Return the current background notification entries.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => notifications.map((notification) => ({
      id: notification.id,
      kind: notification.kind,
      severity: notification.severity,
      title: notification.title,
      body: notification.body,
      count: notification.count,
      readAt: notification.readAt,
      actionType: notification.action?.type ?? null,
      actionLabel: notification.actionLabel ?? null,
    })),
  }), [notifications]);
  useControlAction(notificationsListAction);
  const activityListAction = useMemo<OpenworkControlAction>(() => ({
    id: "activity.list",
    label: "List activity",
    description: "Read this member's device-observed activity and verification status.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => ({ entries: context.entries, verifiedAt: context.verifiedAt, seenAt: context.seenAt ?? null, baseline: context.baseline ?? null, unreadCount, refreshState }),
  }), [context, refreshState, unreadCount]);
  useControlAction(activityListAction);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    // A1/A5: closing the popover marks what it showed as read on this device.
    if (!next) markSeen();
  }, [markSeen]);

  useEffect(() => {
    if (!config.notifications) return;
    const handler = () => setOpen(true);
    window.addEventListener(openNotificationCenterEvent, handler);
    return () => window.removeEventListener(openNotificationCenterEvent, handler);
  }, [config.notifications]);

  if (!config.notifications) return null;

  const close = () => handleOpenChange(false);
  const row = (item: ActivityFeedItem) => (
    <ActivityRow key={item.id} item={item} now={now} compact onResourceOpen={close} />
  );
  const empty = items.length === 0;
  const body = () => {
    if (loading) return <ActivityLoading compact />;
    if (empty) {
      if (refreshState === "error") return null;
      return nothingSharedYet ? <ActivityNothingShared compact onNavigate={close} /> : <ActivityEmpty compact />;
    }
    if (unreadCount > 0) return <div role="list" className="px-1.5 pb-1.5">{items.slice(0, 5).map(row)}</div>;
    return (
      <div className="px-1.5 pb-1.5">
        <ActivityCaughtUp />
        <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{t("activity.earlier")}</p>
        <div role="list">{items.slice(0, 3).map(row)}</div>
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={
        <Button
          variant="ghost"
          size="icon-sm"
          data-notification-bell
          className={cn("relative rounded-lg titlebar-no-drag", onActivityPage && "bg-muted")}
          title={t("activity.title")}
          aria-label={unreadCount > 0 ? t("activity.bell_unread", { count: unreadCount }) : t("activity.title")}
          aria-current={onActivityPage ? "page" : undefined}
        >
          <Bell strokeWidth={1.5} />
          {unreadCount > 0 && !open ? (
            <span data-notification-unread aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-sidebar-primary" />
          ) : null}
        </Button>
      } />
      <PopoverContent align={align} side="bottom" sideOffset={4} data-notification-panel className={cn("max-w-[calc(100vw-1rem)] gap-0 overflow-hidden rounded-xl p-0 data-open:animate-none motion-reduce:animate-none!", empty && !nothingSharedYet ? "w-95" : "w-85")}>
        <div className="flex h-10 items-center justify-between gap-3 px-3.5">
          <PopoverTitle className="text-sm font-semibold">{t("activity.title")}</PopoverTitle>
          {!empty ? (
            <Button variant="ghost" size="xs" onClick={() => { close(); navigate("/activity"); }}>
              {t("activity.view_all")}
            </Button>
          ) : null}
        </div>
        {refreshState === "error" ? <ActivityRefreshError verifiedAt={context.verifiedAt} now={now} compact /> : null}
        {body()}
      </PopoverContent>
    </Popover>
  );
}
