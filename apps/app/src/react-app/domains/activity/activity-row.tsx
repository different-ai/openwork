/** @jsxImportSource react */
import { LayoutGrid, LockKeyhole, Minus, Package, Plug, Plus, RefreshCw, ScrollText, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";
import { IconImage } from "@/react-app/design-system/icon-image";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import type { ActivityBaseline, ActivityResource, MemberActivityEntry } from "@/react-app/kernel/activity-types";
import type { ActivityFeedItem } from "./use-activity-feed";

/** Shared, actorless copy: Activity only knows what this device observed, never who did it. */
export function activityLabel(entry: MemberActivityEntry, compact: boolean) {
  const { resource } = entry;
  const label = resource.label;
  if (entry.change === "unavailable") return t(compact ? "activity.compact_unavailable" : "activity.unavailable", { label });
  if (entry.change === "updated") {
    if (compact) return t("activity.compact_updated", { label });
    return t(resource.kind === "skill" ? "activity.new_version" : "activity.updated", { label });
  }
  if (resource.kind === "connection" || resource.kind === "provider") {
    return t(compact ? "activity.compact_ready" : "activity.ready_to_use", { label });
  }
  if (resource.kind === "plugin" && resource.marketplaceName) {
    return t(compact ? "activity.compact_added_to" : "activity.added_to_marketplace", { label, marketplace: resource.marketplaceName });
  }
  return t(compact ? "activity.compact_shared" : "activity.shared_with_you", { label });
}

function activityDetail(entry: MemberActivityEntry) {
  const { resource } = entry;
  if (entry.change !== "unavailable") {
    if (resource.kind === "skill" && resource.pluginName) return t("activity.skill_in_plugin", { plugin: resource.pluginName });
    if (resource.kind === "plugin" && resource.skillCount) return t("activity.plugin_skills", { count: resource.skillCount });
    if (resource.kind === "connection" && entry.change === "available") return t("activity.connected_by_org");
  }
  return t(RESOURCE_KIND[resource.kind]);
}

export function baselineLabel(baseline: ActivityBaseline) {
  return t("activity.baseline", { count: baseline.labels.length });
}

function baselineDetail(baseline: ActivityBaseline) {
  const shown = baseline.labels.slice(0, 3);
  const items = shown.join(t("activity.list_separator"));
  const more = baseline.labels.length - shown.length;
  return more > 0 ? t("activity.baseline_list_more", { items, count: more }) : items;
}

export function formatActivityTime(timestamp: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes === 0) return t("activity.just_now");
  if (minutes < 60) return t("activity.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("activity.hours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("activity.yesterday");
  if (days < 7) return new Date(timestamp).toLocaleDateString(currentLocale(), { weekday: "short" });
  return new Date(timestamp).toLocaleDateString(currentLocale(), { month: "short", day: "numeric" });
}

function ObservedTime({ timestamp, now, compact = false }: { timestamp: number; now: number; compact?: boolean }) {
  const label = t("activity.observed_at", { time: new Date(timestamp).toLocaleString(currentLocale()) });
  if (compact) {
    return <time dateTime={new Date(timestamp).toISOString()} aria-label={label} title={label} className="shrink-0 text-[11px] text-muted-foreground/70">{formatActivityTime(timestamp, now)}</time>;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={new Date(timestamp).toISOString()} aria-label={label} tabIndex={0} />} className="w-16 shrink-0 rounded-sm text-right text-xs text-muted-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {formatActivityTime(timestamp, now)}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Fixed slot so times align whether or not a row is unread (A1). */
function UnreadDot({ unread }: { unread: boolean }) {
  return (
    <span className="flex size-1.5 shrink-0 items-center justify-center">
      {unread ? <span data-activity-unread aria-label={t("activity.unread")} role="img" className="size-1.5 rounded-full bg-sidebar-primary" /> : null}
    </span>
  );
}

const KIND_ICON: Record<ActivityResource["kind"], LucideIcon> = {
  provider: Plug,
  skill: ScrollText,
  plugin: Package,
  connection: Plug,
};

function ResourceMark({ entry, compact }: { entry: MemberActivityEntry; compact: boolean }) {
  const { resource } = entry;
  const removed = entry.change === "unavailable";
  const ChangeIcon = entry.change === "available" ? Plus : entry.change === "updated" ? RefreshCw : Minus;
  if (compact && (!resource.serviceId || removed)) {
    return <ChangeIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" strokeWidth={1.5} />;
  }
  const KindIcon = removed ? LockKeyhole : KIND_ICON[resource.kind];
  const fallback = <KindIcon className="size-3.5" strokeWidth={1.5} />;
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center text-muted-foreground", compact ? "size-3.5" : "size-6 rounded-full", !compact && (removed || !resource.serviceId) && "bg-muted")}>
      {removed ? fallback : resource.kind === "provider" && resource.serviceId ? (
        <ProviderIcon providerId={resource.serviceId} providerName={resource.label} />
      ) : resource.serviceId ? (
        <IconImage src={resolveExtensionIconUrl({ iconSlug: resource.serviceId })} size={compact ? 14 : 16} fallback={fallback} />
      ) : fallback}
    </span>
  );
}

const RESOURCE_ACTION: Record<ActivityResource["kind"], string> = {
  provider: "activity.open",
  skill: "activity.open",
  plugin: "activity.browse",
  connection: "activity.open",
};

const RESOURCE_KIND: Record<ActivityResource["kind"], string> = {
  provider: "activity.kind_provider", skill: "activity.kind_skill", plugin: "activity.kind_plugin", connection: "activity.kind_connection",
};

const ACTION_LAYOUT = "min-w-18 shrink-0 justify-end px-0 font-medium";

/** A newly shared skill with a known Connect capability can be tried in a new session. */
export function canTrySkill(entry: MemberActivityEntry) {
  return entry.resource.kind === "skill" && entry.change === "available"
    && Boolean(entry.resource.skillSlug && entry.resource.capability);
}

export type ActivityRowProps = {
  item: ActivityFeedItem;
  now: number;
  compact?: boolean;
  onResourceOpen?: () => void;
  onTrySkill?: (resource: ActivityResource) => void;
};

export function ActivityRow({ item, now, compact = false, onResourceOpen, onTrySkill }: ActivityRowProps) {
  const rowLayout = cn("flex min-w-0 items-center rounded-lg", compact ? "h-8.5 gap-2.5 px-2" : "min-h-13 gap-3 px-3 py-2 hover:bg-muted/40");
  const titleClass = "block truncate text-sm font-normal leading-4.5";
  const detailClass = "mt-0.5 block truncate text-xs leading-4 text-muted-foreground/70";

  if (item.type === "baseline") {
    const label = baselineLabel(item.baseline);
    const content = (
      <>
        <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center text-muted-foreground", compact ? "size-3.5" : "size-6")}>
          <LayoutGrid className="size-3.5" strokeWidth={1.5} />
        </span>
        <span className="min-w-0 flex-1 text-start" title={label}>
          <span className={titleClass}>{label}</span>
          {!compact ? <span className={detailClass}>{baselineDetail(item.baseline)}</span> : null}
        </span>
        <ObservedTime timestamp={item.timestamp} now={now} compact={compact} />
      </>
    );
    if (compact) {
      return (
        <div role="listitem" data-activity-row="baseline" data-activity-kind="baseline">
          <Link to="/extensions" onClick={onResourceOpen} className={cn(buttonVariants({ variant: "ghost" }), rowLayout, "w-full justify-start")} aria-label={t("activity.open_library")} aria-description={label}>
            {content}
            <UnreadDot unread={false} />
          </Link>
        </div>
      );
    }
    return (
      <div role="listitem" data-activity-row="baseline" data-activity-kind="baseline" className={rowLayout}>
        {content}
        <Link to="/extensions" className={cn(buttonVariants({ variant: "ghost", size: "xs" }), ACTION_LAYOUT)}>{t("activity.open_library")}</Link>
      </div>
    );
  }

  const { entry, unavailable } = item;
  const removed = entry.change === "unavailable";
  const label = activityLabel(entry, compact);
  const hasDestination = !unavailable && entry.resource.href.startsWith("/") && !entry.resource.href.startsWith("//");
  const content = (
    <>
      <ResourceMark entry={entry} compact={compact} />
      <span className="min-w-0 flex-1 text-start" title={label}>
        <span className={titleClass}>{label}</span>
        {!compact ? <span className={detailClass}>{activityDetail(entry)}</span> : null}
      </span>
      <ObservedTime timestamp={item.timestamp} now={now} compact={compact} />
      {compact ? <UnreadDot unread={item.unread} /> : null}
    </>
  );
  if (compact && hasDestination) {
    return (
      <div role="listitem" data-activity-row={entry.id} data-activity-kind={entry.resource.kind}>
        <Link to={entry.resource.href} onClick={onResourceOpen} className={cn(buttonVariants({ variant: "ghost" }), rowLayout, "w-full justify-start")} aria-label={t("activity.open_resource", { label: entry.resource.label })} aria-description={label}>
          {content}
        </Link>
      </div>
    );
  }
  let action: ReactNode = null;
  if (!compact) {
    if (removed) {
      // P4/C5: the lock and who can change it, never a dead action.
      action = (
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} />} className="min-w-18 shrink-0 rounded-sm text-right text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" data-activity-ask-admin>
            {t("activity.ask_admin")}
          </TooltipTrigger>
          <TooltipContent>{t("activity.ask_admin_hint")}</TooltipContent>
        </Tooltip>
      );
    } else if (hasDestination && onTrySkill && canTrySkill(entry)) {
      action = (
        <Button variant="ghost" size="xs" className={ACTION_LAYOUT} aria-label={t("activity.try_resource", { label: entry.resource.label })} onClick={() => onTrySkill(entry.resource)}>
          {t("activity.try_it")}
        </Button>
      );
    } else if (hasDestination) {
      action = (
        <Link to={entry.resource.href} className={cn(buttonVariants({ variant: "ghost", size: "xs" }), ACTION_LAYOUT)} aria-label={t("activity.open_resource", { label: entry.resource.label })}>
          {t(RESOURCE_ACTION[entry.resource.kind])}
        </Link>
      );
    } else {
      action = <span className="w-18 shrink-0" />;
    }
  }
  return (
    <div role="listitem" data-activity-row={entry.id} data-activity-kind={entry.resource.kind} data-unavailable={removed || undefined} className={cn(rowLayout, removed && "text-muted-foreground/70")}>
      {content}
      {action}
    </div>
  );
}
