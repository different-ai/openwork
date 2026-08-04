/** @jsxImportSource react */
import { useCallback, useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  FileText,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "@/components/ui/sonner";
import type {
  ReviewScheduledTaskGrant,
  ScheduledTask,
  ScheduledTaskArtifactReference,
  ScheduledTaskDefinition,
  ScheduledTaskGrant,
  ScheduledTaskRevision,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
  ScheduledTaskState,
} from "@openwork/types/scheduled-tasks";

import {
  OpenworkServerError,
  type OpenworkServerCapabilities,
} from "@/app/lib/openwork-server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { useControlAction, type OpenworkControlAction } from "@/react-app/shell/control/control-provider";
import { scheduledTasksCreateRoute, scheduledTasksRoute, workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { ScheduledTaskEditor } from "./scheduled-task-editor";
import { formatScheduledTaskWeekdays } from "./scheduled-task-format";
import type {
  ScheduledTaskDetail,
  ScheduledTaskListItem,
  ScheduledTasksClient,
} from "./scheduled-tasks-client";

const ACTIVE_RUN_STATUSES = new Set<ScheduledTaskRun["status"]>([
  "scheduled",
  "claimed",
  "running",
  "retrying",
]);

export type ScheduledTaskTarget = {
  routeWorkspaceId: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceLabel: string;
  client: ScheduledTasksClient;
};

type ScheduledTasksPageProps = {
  targets: ScheduledTaskTarget[];
  taskWorkspaceId: string | null;
  taskId: string | null;
};

type ScheduledTaskListEntry = {
  item: ScheduledTaskListItem;
  target: ScheduledTaskTarget;
};

function formatTime(value: number | null | undefined) {
  if (typeof value !== "number") return t("scheduled_tasks.not_scheduled");
  return new Date(value).toLocaleString();
}

function formatDuration(value: number | null | undefined) {
  if (typeof value !== "number") return "—";
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

function scheduleLabel(schedule: ScheduledTaskSchedule) {
  if (schedule.kind === "manual") return t("scheduled_tasks.manual");
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.kind === "daily") {
    return `${t("scheduled_tasks.daily")} · ${time} · ${schedule.timezone}`;
  }
  const days = formatScheduledTaskWeekdays(schedule.daysOfWeek);
  return `${t("scheduled_tasks.weekly")} · ${days} · ${time} · ${schedule.timezone}`;
}

function stateLabel(state: ScheduledTaskState) {
  const keyByState = {
    deleted: "scheduled_tasks.state_deleted",
    draft: "scheduled_tasks.state_draft",
    enabled: "scheduled_tasks.state_enabled",
    "needs-attention": "scheduled_tasks.state_needs_attention",
    paused: "scheduled_tasks.state_paused",
    ready: "scheduled_tasks.state_ready",
  } as const;
  return t(keyByState[state]);
}

function filterLabel(filter: ScheduledTaskFilter) {
  if (filter === "active") return t("scheduled_tasks.filter_active");
  if (filter === "paused") return t("scheduled_tasks.filter_paused");
  return t("scheduled_tasks.filter_all");
}

function stateBadgeVariant(state: ScheduledTaskState): "default" | "secondary" | "destructive" | "outline" {
  if (state === "enabled") return "default";
  if (state === "needs-attention") return "destructive";
  if (state === "paused") return "secondary";
  return "outline";
}

function describeError(error: unknown) {
  if (error instanceof OpenworkServerError) {
    if (
      error.status === 401
      || error.status === 403
      || error.code.includes("workspace")
    ) {
      return t("scheduled_tasks.error_inaccessible");
    }
    if (error.code.includes("revision") || error.code.includes("stale")) {
      return t("scheduled_tasks.error_stale");
    }
    if (error.status === 404) {
      return t("scheduled_tasks.error_not_found");
    }
    return error.message;
  }
  return error instanceof Error ? error.message : t("scheduled_tasks.error_generic");
}

function downloadBlob(data: ArrayBuffer, filename: string, contentType: string | null) {
  const url = URL.createObjectURL(new Blob([data], { type: contentType ?? "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function LimitationNote({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={compact
        ? "flex items-center gap-2 text-xs text-muted-foreground"
        : "flex items-center gap-2 text-sm text-muted-foreground"
      }
      data-scheduled-task-limitation
    >
      <Clock3 className="size-4 shrink-0" aria-hidden="true" />
      <span>{t("scheduled_tasks.limit_copy")}</span>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4 p-6" role="status" aria-label={t("scheduled_tasks.loading")}>
      <Skeleton className="h-24 rounded-2xl" />
      <Skeleton className="h-44 rounded-2xl" />
      <Skeleton className="h-44 rounded-2xl" />
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-16 text-center" role="alert">
      <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
      <div>
        <h2 className="font-medium">{t("scheduled_tasks.error_title")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{describeError(error)}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        {t("common.refresh")}
      </Button>
    </div>
  );
}

function UnavailableState({ reason }: { reason: string }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <Alert variant="warning">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>{t("scheduled_tasks.unavailable_title")}</AlertTitle>
        <AlertDescription>{reason}</AlertDescription>
      </Alert>
    </div>
  );
}

type ScheduledTaskFilter = "all" | "active" | "paused";
type ScheduledTaskSuggestionId = "daily-brief" | "weekly-review" | "follow-up-monitor";

const SCHEDULED_TASK_SUGGESTIONS: Array<{
  id: ScheduledTaskSuggestionId;
  titleKey: "scheduled_tasks.suggestion_daily_title" | "scheduled_tasks.suggestion_weekly_title" | "scheduled_tasks.suggestion_follow_up_title";
  scheduleKey: "scheduled_tasks.suggestion_daily_schedule" | "scheduled_tasks.suggestion_weekly_schedule" | "scheduled_tasks.suggestion_follow_up_schedule";
  copyKey: "scheduled_tasks.suggestion_daily_copy" | "scheduled_tasks.suggestion_weekly_copy" | "scheduled_tasks.suggestion_follow_up_copy";
  promptKey: "scheduled_tasks.suggestion_daily_prompt" | "scheduled_tasks.suggestion_weekly_prompt" | "scheduled_tasks.suggestion_follow_up_prompt";
}> = [
  {
    id: "daily-brief",
    titleKey: "scheduled_tasks.suggestion_daily_title",
    scheduleKey: "scheduled_tasks.suggestion_daily_schedule",
    copyKey: "scheduled_tasks.suggestion_daily_copy",
    promptKey: "scheduled_tasks.suggestion_daily_prompt",
  },
  {
    id: "weekly-review",
    titleKey: "scheduled_tasks.suggestion_weekly_title",
    scheduleKey: "scheduled_tasks.suggestion_weekly_schedule",
    copyKey: "scheduled_tasks.suggestion_weekly_copy",
    promptKey: "scheduled_tasks.suggestion_weekly_prompt",
  },
  {
    id: "follow-up-monitor",
    titleKey: "scheduled_tasks.suggestion_follow_up_title",
    scheduleKey: "scheduled_tasks.suggestion_follow_up_schedule",
    copyKey: "scheduled_tasks.suggestion_follow_up_copy",
    promptKey: "scheduled_tasks.suggestion_follow_up_prompt",
  },
];

function taskGroupId(item: ScheduledTaskListItem) {
  if (item.task.state === "needs-attention" || item.task.needsAttention) return "needs-attention";
  if (item.latestRun && ACTIVE_RUN_STATUSES.has(item.latestRun.status)) return "running";
  if (item.task.enabled && item.task.nextRunAt !== null) return "upcoming";
  return "recent";
}

function suggestionDefinition(workspaceId: string, suggestionId: ScheduledTaskSuggestionId): ScheduledTaskDefinition {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const suggestion = SCHEDULED_TASK_SUGGESTIONS.find((candidate) => candidate.id === suggestionId)!;
  const schedule: ScheduledTaskSchedule = suggestionId === "weekly-review"
    ? { kind: "weekly", timezone, daysOfWeek: [5], hour: 16, minute: 0 }
    : { kind: "weekly", timezone, daysOfWeek: [1, 2, 3, 4, 5], hour: suggestionId === "daily-brief" ? 8 : 9, minute: 0 };
  return {
    name: t(suggestion.titleKey),
    description: t(suggestion.copyKey),
    prompt: t(suggestion.promptKey),
    workspaceId,
    schedule,
    model: { providerId: null, modelId: null, agent: null },
    maximumRuntimeMs: 30 * 60 * 1_000,
    overlapPolicy: "skip",
    retryPolicy: { maximumAttempts: 1, delayMs: 0 },
    missedRunPolicy: { kind: "skip", graceMs: 60_000, maximumRecoverableOccurrences: 1 },
  };
}

function TaskListRow({
  item,
  selected,
  workspaceLabel,
  onOpen,
}: {
  item: ScheduledTaskListItem;
  selected: boolean;
  workspaceLabel: string;
  onOpen: () => void;
}) {
  const definition = item.revision.definition;
  const timing = item.task.nextRunAt === null
    ? scheduleLabel(definition.schedule)
    : `${scheduleLabel(definition.schedule)} · ${formatTime(item.task.nextRunAt)}`;

  return (
    <button
      type="button"
      className={cn(
        "group w-full rounded-xl border px-3 py-3 text-left transition-colors",
        selected
          ? "border-foreground/60 bg-muted/60 shadow-sm"
          : "border-transparent hover:border-border hover:bg-muted/35",
      )}
      data-open-scheduled-task={item.task.id}
      data-scheduled-task-card={item.task.id}
      data-scheduled-task-group={taskGroupId(item)}
      aria-current={selected ? "page" : undefined}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Clock3 className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{definition.name}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{timing}</span>
          <span className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span className={cn("size-1.5 shrink-0 rounded-full", item.task.state === "needs-attention" ? "bg-destructive" : item.task.state === "enabled" ? "bg-green-9" : "bg-muted-foreground/50")} />
            <span>{stateLabel(item.task.state)}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{workspaceLabel}</span>
          </span>
        </span>
        <ChevronRight className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-opacity", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100")} aria-hidden="true" />
      </div>
    </button>
  );
}

function ScheduledTaskList({
  items,
  selectedTaskId,
  selectedWorkspaceId,
  canWrite,
  onCreate,
  onCreateSuggestion,
  onOpen,
}: {
  items: ScheduledTaskListEntry[];
  selectedTaskId: string | null;
  selectedWorkspaceId: string | null;
  canWrite: boolean;
  onCreate: () => void;
  onCreateSuggestion: (suggestionId: ScheduledTaskSuggestionId) => void;
  onOpen: (workspaceId: string, taskId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ScheduledTaskFilter>("all");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredItems = useMemo(() => items.filter((item) => {
    const matchesQuery = !normalizedQuery || [
      item.item.revision.definition.name,
      item.item.revision.definition.description,
      item.target.workspaceLabel,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    const matchesFilter = filter === "all"
      || (filter === "paused" && item.item.task.state === "paused")
      || (filter === "active" && item.item.task.state !== "paused" && item.item.task.state !== "deleted");
    return matchesQuery && matchesFilter;
  }), [filter, items, normalizedQuery]);

  return (
    <div className="flex min-h-full flex-col" data-testid="scheduled-tasks-list">
      <div className="space-y-4 border-b border-border px-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">{t("scheduled_tasks.title")}</h2>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{t("scheduled_tasks.subtitle")}</p>
          </div>
          <Button size="sm" data-testid="scheduled-task-create" disabled={!canWrite} onClick={onCreate}>
            <Plus aria-hidden="true" />
            <span>{t("scheduled_tasks.create_short")}</span>
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            className="ps-9"
            value={query}
            placeholder={t("scheduled_tasks.search_placeholder")}
            aria-label={t("scheduled_tasks.search_placeholder")}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div className="flex items-center gap-1" role="group" aria-label={t("scheduled_tasks.filters")}>
          {(["all", "active", "paused"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              className="h-8 px-3"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {filterLabel(value)}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-5 px-4 py-4">
        {filteredItems.length > 0 ? (
          <div className="space-y-1">
            {filteredItems.map(({ item, target }) => (
              <TaskListRow
                key={`${target.routeWorkspaceId}:${item.task.id}`}
                item={item}
                selected={item.task.id === selectedTaskId && target.routeWorkspaceId === selectedWorkspaceId}
                workspaceLabel={target.workspaceLabel}
                onOpen={() => onOpen(target.routeWorkspaceId, item.task.id)}
              />
            ))}
          </div>
        ) : items.length === 0 ? (
          <Empty className="min-h-52 flex-none border-0 px-6 py-8">
            <EmptyHeader className="w-full">
              <EmptyMedia variant="icon"><Clock3 aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{t("scheduled_tasks.empty_title")}</EmptyTitle>
              <EmptyDescription>{t("scheduled_tasks.empty_copy")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("scheduled_tasks.no_matches")}</p>
        )}

        {items.length < 4 && !normalizedQuery && filter === "all" ? (
          <section className="border-t border-border pt-4" aria-labelledby="scheduled-task-suggestions-heading">
            <h3 id="scheduled-task-suggestions-heading" className="text-xs font-medium text-muted-foreground">{t("scheduled_tasks.suggestions")}</h3>
            <div className="mt-2 space-y-1">
              {SCHEDULED_TASK_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="w-full rounded-xl py-2.5 text-left transition-colors hover:bg-muted/40"
                  disabled={!canWrite}
                  onClick={() => onCreateSuggestion(suggestion.id)}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{t(suggestion.titleKey)}</span>
                    <span className="truncate text-xs text-muted-foreground">{t(suggestion.scheduleKey)}</span>
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-xs leading-5 text-muted-foreground">{t(suggestion.copyKey)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <div className="border-t border-border px-4 py-3">
        <LimitationNote compact />
      </div>
    </div>
  );
}

type AuthorityEditorProps = {
  detail: ScheduledTaskDetail;
  workspaceLabel: string;
  workspaceRoot: string;
  busy: boolean;
  canWrite: boolean;
  onReview: (input: ReviewScheduledTaskGrant) => void;
  onRevoke: () => void;
};

function AuthorityEditor(props: AuthorityEditorProps) {
  const existing = props.detail.grant;
  const definition = props.detail.draftRevision.definition;
  const [roots, setRoots] = useState(
    () => existing?.authorizedWorkspaceRoots.join("\n") || props.workspaceRoot,
  );
  const [capabilities, setCapabilities] = useState(
    () => existing?.capabilityIds.join("\n") || "workspace.files.read",
  );
  const [actionClasses, setActionClasses] = useState<Array<"read" | "write" | "execute">>(
    () => existing?.actionClasses ?? ["read"],
  );
  const [filesystemRead, setFilesystemRead] = useState(existing?.filesystem.read ?? true);
  const [filesystemWrite, setFilesystemWrite] = useState(existing?.filesystem.write ?? false);
  const [grantor, setGrantor] = useState(existing?.grantor ?? t("scheduled_tasks.default_grantor"));
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);

  const toggleAction = (action: "read" | "write" | "execute") => {
    setActionClasses((current) => {
      if (current.includes(action)) {
        return current.length === 1 ? current : current.filter((candidate) => candidate !== action);
      }
      return [...current, action];
    });
  };

  return (
    <Card variant="outline" className="rounded-2xl" data-testid="scheduled-task-authority">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden="true" />
          {t("scheduled_tasks.authority_title")}
        </CardTitle>
        <CardDescription>{t("scheduled_tasks.authority_copy")}</CardDescription>
        <CardAction>
          <Badge variant={existing && existing.revokedAt === null ? "secondary" : "outline"}>
            {existing && existing.revokedAt === null ? t("scheduled_tasks.reviewed") : t("scheduled_tasks.review_required")}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 rounded-xl bg-muted/40 p-3 text-sm sm:grid-cols-2" data-testid="scheduled-task-authority-workspace">
          <div>
            <span className="block text-xs text-muted-foreground">{t("scheduled_tasks.workspace")}</span>
            <span className="mt-0.5 block font-medium">{props.workspaceLabel}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">{t("scheduled_tasks.timeout_minutes")}</span>
            <span className="mt-0.5 block font-medium">{Math.round(definition.maximumRuntimeMs / 60_000)}</span>
          </div>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">{t("scheduled_tasks.action_classes")}</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {(["read", "write", "execute"] as const).map((action) => (
              <label key={action} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-action-class={action}
                  checked={actionClasses.includes(action)}
                  onChange={() => toggleAction(action)}
                />
                {action}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-5">
          <label className="flex items-center gap-2 text-sm">
            <input data-filesystem-read type="checkbox" checked={filesystemRead} onChange={(event) => setFilesystemRead(event.currentTarget.checked)} />
            {t("scheduled_tasks.filesystem_read")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input data-filesystem-write type="checkbox" checked={filesystemWrite} onChange={(event) => setFilesystemWrite(event.currentTarget.checked)} />
            {t("scheduled_tasks.filesystem_write")}
          </label>
        </div>
        <div className="grid gap-3 rounded-xl bg-muted/50 p-3 text-xs sm:grid-cols-3">
          <div><span className="block font-medium">{t("scheduled_tasks.communication")}</span>{t("scheduled_tasks.denied")}</div>
          <div><span className="block font-medium">{t("scheduled_tasks.destructive_actions")}</span>{t("scheduled_tasks.denied")}</div>
          <div><span className="block font-medium">{t("scheduled_tasks.self_modification")}</span>{t("scheduled_tasks.denied")}</div>
        </div>
        <div className="max-w-sm space-y-2">
          <Label htmlFor="scheduled-task-grantor">{t("scheduled_tasks.reviewed_by")}</Label>
          <Input id="scheduled-task-grantor" value={grantor} onChange={(event) => setGrantor(event.currentTarget.value)} />
        </div>
        <div className="overflow-hidden rounded-xl border border-border">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/40"
            aria-expanded={technicalOpen}
            onClick={() => setTechnicalOpen((current) => !current)}
          >
            <span>
              <span className="block font-medium">{t("scheduled_tasks.technical_scope")}</span>
              <span className="block text-xs text-muted-foreground">{t("scheduled_tasks.technical_scope_copy")}</span>
            </span>
            <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", technicalOpen && "rotate-90")} aria-hidden="true" />
          </button>
          {technicalOpen ? (
            <div className="grid gap-4 border-t border-border p-3 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="scheduled-task-authorized-roots">{t("scheduled_tasks.authorized_roots")}</Label>
                <Textarea id="scheduled-task-authorized-roots" data-testid="scheduled-task-authorized-roots" className="min-h-24 font-mono text-xs" value={roots} onChange={(event) => setRoots(event.currentTarget.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled-task-capabilities">{t("scheduled_tasks.capability_ids")}</Label>
                <Textarea id="scheduled-task-capabilities" data-testid="scheduled-task-capabilities" className="min-h-24 font-mono text-xs" value={capabilities} placeholder={t("scheduled_tasks.capability_ids_placeholder")} onChange={(event) => setCapabilities(event.currentTarget.value)} />
              </div>
            </div>
          ) : null}
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        {existing && existing.revokedAt === null ? (
          <Button
            type="button"
            variant="outline"
            className="me-auto text-destructive"
            disabled={!props.canWrite || props.busy}
            onClick={() => setRevokeConfirmOpen(true)}
          >
            {t("scheduled_tasks.revoke_authority")}
          </Button>
        ) : null}
        <Button
          type="button"
          data-testid="scheduled-task-review-authority"
          disabled={!props.canWrite || props.busy || !roots.trim() || !grantor.trim()}
          onClick={() => props.onReview({
            expectedRevisionId: props.detail.draftRevision.id,
            authorizedWorkspaceRoots: roots.split("\n").map((value) => value.trim()).filter(Boolean),
            capabilityIds: capabilities.split("\n").map((value) => value.trim()).filter(Boolean),
            actionClasses,
            filesystem: { read: filesystemRead, write: filesystemWrite },
            maximumRuntimeMs: definition.maximumRuntimeMs,
            model: definition.model,
            expiresAt: null,
            grantor: grantor.trim(),
          })}
        >
          <ShieldCheck aria-hidden="true" />
          {t("scheduled_tasks.approve_authority")}
        </Button>
      </CardFooter>
      <ConfirmModal
        open={revokeConfirmOpen}
        title={t("scheduled_tasks.revoke_confirm_title")}
        message={t("scheduled_tasks.revoke_confirm_copy")}
        confirmLabel={t("scheduled_tasks.revoke_authority")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => setRevokeConfirmOpen(false)}
        onConfirm={() => {
          setRevokeConfirmOpen(false);
          props.onRevoke();
        }}
      />
    </Card>
  );
}

function ArtifactLink({
  artifact,
  onOpen,
}: {
  artifact: ScheduledTaskArtifactReference;
  onOpen: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-scheduled-task-artifact={artifact.id}
      aria-label={`${t("scheduled_tasks.open_artifact")} ${artifact.name ?? artifact.value}`}
      onClick={onOpen}
    >
      {artifact.kind === "url" ? <ExternalLink aria-hidden="true" /> : <FileText aria-hidden="true" />}
      <span className="max-w-56 truncate">{artifact.name ?? artifact.value}</span>
    </Button>
  );
}

function RunHistory({
  detail,
  busyAction,
  canExecute,
  onCancel,
  onDownloadReceipt,
  onOpenSession,
  onOpenArtifact,
}: {
  detail: ScheduledTaskDetail;
  busyAction: string | null;
  canExecute: boolean;
  onCancel: (runId: string) => void;
  onDownloadReceipt: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenArtifact: (
    runId: string,
    artifact: ScheduledTaskArtifactReference,
  ) => void;
}) {
  if (detail.runs.length === 0) {
    return (
      <Card variant="outline" className="rounded-2xl">
        <CardHeader>
          <CardTitle>{t("scheduled_tasks.run_history")}</CardTitle>
          <CardDescription>{t("scheduled_tasks.no_runs")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card variant="outline" className="rounded-2xl" data-testid="scheduled-task-run-history">
      <CardHeader>
        <CardTitle>{t("scheduled_tasks.run_history")}</CardTitle>
        <CardDescription>{t("scheduled_tasks.run_history_copy")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {detail.runs.map((run, index) => (
          <div key={run.id} className="rounded-xl border border-border p-4" data-scheduled-task-run={run.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  {run.status === "completed" ? (
                    <CheckCircle2 className="size-4 text-green-10" aria-hidden="true" />
                  ) : run.status === "failed" || run.status === "needs-attention" ? (
                    <XCircle className="size-4 text-destructive" aria-hidden="true" />
                  ) : (
                    <Clock3 className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="text-sm font-medium">{run.status}</span>
                  <Badge variant="outline">{run.trigger}</Badge>
                  {index === 0 ? <span className="text-xs text-muted-foreground">{t("scheduled_tasks.latest_run")}</span> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatTime(run.createdAt)} · {formatDuration(run.durationMs)} · {run.attemptCount} {t("scheduled_tasks.attempts")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("scheduled_tasks.usage_summary", {
                    input: run.boundedUsage.inputTokens ?? 0,
                    output: run.boundedUsage.outputTokens ?? 0,
                    cost: run.boundedUsage.costMicros ?? 0,
                  })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {run.sessionId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-open-scheduled-task-session={run.sessionId}
                    onClick={() => onOpenSession(run.sessionId!)}
                  >
                    {t("scheduled_tasks.open_session")}
                  </Button>
                ) : null}
                <Button type="button" variant="outline" size="sm" onClick={() => onDownloadReceipt(run.id)}>
                  <ReceiptText aria-hidden="true" />
                  {t("scheduled_tasks.download_receipt")}
                </Button>
                {ACTIVE_RUN_STATUSES.has(run.status) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canExecute || busyAction !== null}
                    onClick={() => onCancel(run.id)}
                  >
                    {t("scheduled_tasks.cancel_run")}
                  </Button>
                ) : null}
              </div>
            </div>
            {run.needsAttention ? (
              <p className="mt-3 rounded-lg bg-red-2/50 px-3 py-2 text-sm text-red-11">{run.needsAttention.message}</p>
            ) : null}
            {run.error ? (
              <p className="mt-3 rounded-lg bg-red-2/50 px-3 py-2 text-sm text-red-11">{run.error.message}</p>
            ) : null}
            {run.artifacts.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {run.artifacts.map((artifact) => (
                  <ArtifactLink
                    key={artifact.id}
                    artifact={artifact}
                    onOpen={() => onOpenArtifact(run.id, artifact)}
                  />
                ))}
              </div>
            ) : null}
            <ol className="mt-3 border-s border-border ps-4 text-xs text-muted-foreground">
              <li>{t("scheduled_tasks.timeline_claimed")} · {formatTime(run.claimedAt)}</li>
              {run.startedAt ? <li>{t("scheduled_tasks.timeline_started")} · {formatTime(run.startedAt)}</li> : null}
              {run.completedAt ? <li>{t("scheduled_tasks.timeline_completed")} · {formatTime(run.completedAt)}</li> : null}
            </ol>
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">{t("scheduled_tasks.diagnostics")}</summary>
              <p className="mt-2 break-all font-mono text-[10px]">
                {t("scheduled_tasks.revision_binding", { task: run.taskRevisionId, grant: run.grantRevisionId })}
              </p>
            </details>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ScheduledTaskDetailView({
  detail,
  routeWorkspaceId,
  workspaceId,
  workspaceLabel,
  workspaceRoot,
  client,
  capabilities,
  onBack,
  onOpenTask,
}: {
  detail: ScheduledTaskDetail;
  routeWorkspaceId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceRoot: string;
  client: ScheduledTasksClient;
  capabilities: NonNullable<OpenworkServerCapabilities["scheduledTasks"]>;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const task = detail.task;
  const definition = detail.draftRevision.definition;
  const hasUnreviewedRevision = Boolean(
    detail.activeRevision
    && detail.activeRevision.id !== detail.draftRevision.id,
  );
  const hasActiveGrant = Boolean(
    detail.grant
    && detail.grant.revokedAt === null
    && (detail.grant.expiresAt === null || detail.grant.expiresAt > Date.now()),
  );
  const previewQuery = useQuery({
    queryKey: ["scheduled-task-preview", workspaceId, detail.draftRevision.id],
    queryFn: () => client.previewScheduledTaskSchedule(workspaceId, {
      schedule: definition.schedule,
    }),
  });

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] }),
      queryClient.invalidateQueries({ queryKey: ["scheduled-task", workspaceId, task.id] }),
    ]);
  }, [queryClient, task.id, workspaceId]);

  const act = async (name: string, action: () => Promise<void>, success: string) => {
    setBusyAction(name);
    try {
      await action();
      await refresh();
      toast.success(success);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const openArtifact = async (
    runId: string,
    artifact: ScheduledTaskArtifactReference,
  ) => {
    if (artifact.kind === "url") {
      window.open(artifact.value, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const result = await client.downloadScheduledTaskArtifact(
        workspaceId,
        task.id,
        runId,
        artifact.id,
      );
      downloadBlob(result.data, artifact.name ?? artifact.value.split("/").at(-1) ?? "artifact", result.contentType);
    } catch (error) {
      toast.error(describeError(error));
    }
  };

  const downloadReceipt = async (runId: string) => {
    try {
      const receipt = await client.getScheduledTaskRunReceipt(workspaceId, task.id, runId);
      const bytes = new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`);
      downloadBlob(bytes.buffer as ArrayBuffer, `${definition.name.replace(/[^a-z0-9]+/gi, "-").toLocaleLowerCase()}-receipt.json`, "application/json");
    } catch (error) {
      toast.error(describeError(error));
    }
  };

  if (editing) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 sm:px-6 sm:py-8">
        <Button variant="ghost" onClick={() => setEditing(false)}>
          <ArrowLeft aria-hidden="true" />
          {t("scheduled_tasks.back_to_task")}
        </Button>
        <div>
          <h2 className="text-2xl font-semibold">{t("scheduled_tasks.edit_title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("scheduled_tasks.edit_copy")}</p>
        </div>
        <ScheduledTaskEditor
          workspaceId={workspaceId}
          initial={definition}
          busy={busyAction === "edit"}
          submitLabel={t("common.save")}
          onCancel={() => setEditing(false)}
          onPreview={async (schedule) => (await client.previewScheduledTaskSchedule(workspaceId, { schedule })).preview}
          onSave={async (nextDefinition) => {
            await act("edit", async () => {
              await client.updateScheduledTaskDraft(workspaceId, task.id, {
                expectedRevisionId: detail.draftRevision.id,
                definition: nextDefinition,
              });
              setEditing(false);
            }, t("scheduled_tasks.updated"));
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 sm:px-6 sm:py-8" data-testid="scheduled-task-detail">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Button variant="ghost" size="icon-sm" className="-ms-2 lg:hidden" aria-label={t("scheduled_tasks.back_to_list")} onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <Badge variant={stateBadgeVariant(task.state)}>{stateLabel(task.state)}</Badge>
              <span className="truncate text-xs text-muted-foreground">{workspaceLabel}</span>
            </div>
            <h2 className="break-words text-xl font-semibold tracking-tight sm:text-2xl">{definition.name}</h2>
            {definition.description ? <p className="mt-1 break-words text-sm text-muted-foreground">{definition.description}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="scheduled-task-run-once"
            disabled={!capabilities.execute || busyAction !== null || !hasActiveGrant}
            onClick={() => void act("run", async () => {
              await client.runScheduledTaskOnce(workspaceId, task.id);
            }, t("scheduled_tasks.run_started"))}
          >
            <Play aria-hidden="true" />
            {t("scheduled_tasks.run_once")}
          </Button>
          {task.state === "paused" && definition.schedule.kind !== "manual" ? (
            <Button type="button" variant="outline" size="sm" data-testid="scheduled-task-resume" disabled={!capabilities.write || busyAction !== null} onClick={() => void act("resume", async () => {
              await client.resumeScheduledTask(workspaceId, task.id);
            }, t("scheduled_tasks.resumed"))}>
              <Play aria-hidden="true" />
              {t("scheduled_tasks.resume")}
            </Button>
          ) : task.enabled || task.state === "needs-attention" ? (
            <Button type="button" variant="outline" size="sm" data-testid="scheduled-task-pause" disabled={!capabilities.write || busyAction !== null} onClick={() => void act("pause", async () => {
              await client.pauseScheduledTask(workspaceId, task.id);
            }, t("scheduled_tasks.paused"))}>
              <Pause aria-hidden="true" />
              {t("scheduled_tasks.pause")}
            </Button>
          ) : definition.schedule.kind !== "manual" ? (
            <Button type="button" variant="outline" size="sm" data-testid="scheduled-task-enable" disabled={!capabilities.write || busyAction !== null || !hasActiveGrant || !task.activeRevisionId} onClick={() => void act("enable", async () => {
              await client.enableScheduledTask(workspaceId, task.id);
            }, t("scheduled_tasks.enabled"))}>
              <Play aria-hidden="true" />
              {t("scheduled_tasks.enable")}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("scheduled_tasks.more_actions")} data-testid="scheduled-task-more-actions" />}>
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!capabilities.write || busyAction !== null} onClick={() => setEditing(true)}>
                <Pencil aria-hidden="true" />
                {t("common.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!capabilities.write || busyAction !== null} onClick={() => void act("duplicate", async () => {
                const result = await client.duplicateScheduledTask(workspaceId, task.id);
                onOpenTask(result.task.id);
              }, t("scheduled_tasks.duplicated"))}>
                <Copy aria-hidden="true" />
                {t("scheduled_tasks.duplicate")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={!capabilities.write || busyAction !== null} onClick={() => setDeleteConfirmOpen(true)}>
                <Trash2 aria-hidden="true" />
                {t("scheduled_tasks.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-sm" className="hidden lg:inline-flex" aria-label={t("scheduled_tasks.close_detail")} onClick={onBack}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>

      {hasUnreviewedRevision ? (
        <Alert variant="warning" data-testid="scheduled-task-stale-revision">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>{t("scheduled_tasks.review_required")}</AlertTitle>
          <AlertDescription>{t("scheduled_tasks.edit_copy")}</AlertDescription>
        </Alert>
      ) : null}

      {task.needsAttention ? (
        <Alert variant="destructive" data-testid="scheduled-task-needs-attention">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>{t("scheduled_tasks.needs_attention")}</AlertTitle>
          <AlertDescription>{task.needsAttention.message}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="scheduled-task-instructions-heading">
        <div className="flex items-center justify-between gap-3">
          <h3 id="scheduled-task-instructions-heading" className="text-sm font-medium">{t("scheduled_tasks.prompt")}</h3>
          <Button variant="ghost" size="sm" disabled={!capabilities.write || busyAction !== null} onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" />
            {t("common.edit")}
          </Button>
        </div>
        <p className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-2xl border border-border bg-muted/25 p-4 text-sm leading-6">{definition.prompt}</p>
      </section>

      <section className="space-y-4" aria-labelledby="scheduled-task-details-heading">
        <h3 id="scheduled-task-details-heading" className="text-sm font-medium text-muted-foreground">{t("scheduled_tasks.details")}</h3>
        <dl className="divide-y divide-border overflow-hidden rounded-2xl border border-border text-sm">
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{t("scheduled_tasks.workspace")}</dt><dd className="font-medium">{workspaceLabel}</dd></div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{t("scheduled_tasks.execution_mode")}</dt><dd>{t("scheduled_tasks.fresh_session")}</dd></div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{t("scheduled_tasks.schedule")}</dt><dd>{scheduleLabel(definition.schedule)}{task.nextRunAt === null ? "" : ` · ${t("scheduled_tasks.next_run")} ${formatTime(task.nextRunAt)}`}</dd></div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{t("scheduled_tasks.notifications")}</dt><dd>{t("scheduled_tasks.notifications_copy")}</dd></div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{t("scheduled_tasks.model_runtime")}</dt><dd>{definition.model.providerId ?? t("scheduled_tasks.default_value")} · {definition.model.modelId ?? t("scheduled_tasks.default_value")} · {Math.round(definition.maximumRuntimeMs / 60_000)} {t("scheduled_tasks.minutes")}</dd></div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{t("scheduled_tasks.authority_title")}</dt><dd>{hasActiveGrant ? t("scheduled_tasks.reviewed") : t("scheduled_tasks.review_required")}</dd></div>
        </dl>

        {definition.schedule.kind !== "manual" ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("scheduled_tasks.next_five")}
              </p>
              {previewQuery.isFetching ? <span className="text-xs text-muted-foreground">{t("scheduled_tasks.preview_loading")}</span> : null}
            </div>
            {previewQuery.error ? (
              <p role="alert" className="text-sm text-destructive">{describeError(previewQuery.error)}</p>
            ) : previewQuery.data ? (
              <>
                <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" data-testid="scheduled-task-detail-preview">
                  {previewQuery.data.preview.occurrences.map((occurrence, index) => (
                    <li key={`${occurrence}:${index}`} className="rounded-xl bg-muted/60 px-3 py-2 text-xs">
                      <span className="block font-medium">{t("scheduled_tasks.occurrence", { count: index + 1 })}</span>
                      <time dateTime={new Date(occurrence).toISOString()}>{new Date(occurrence).toLocaleString()}</time>
                    </li>
                  ))}
                </ol>
                {previewQuery.data.preview.warnings.length > 0 ? (
                  <ul className="space-y-1 text-xs text-amber-11" data-testid="scheduled-task-preview-warnings">
                    {previewQuery.data.preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        <div className="space-y-1 text-xs text-muted-foreground">
          <LimitationNote compact />
          <p>{t("scheduled_tasks.fixed_policies")}</p>
        </div>
        {!hasActiveGrant ? <p className="text-xs text-muted-foreground">{t("scheduled_tasks.review_before_run")}</p> : null}
      </section>

      <AuthorityEditor
        key={detail.draftRevision.id}
        detail={detail}
        workspaceLabel={workspaceLabel}
        workspaceRoot={workspaceRoot}
        busy={busyAction === "review"}
        canWrite={capabilities.write}
        onReview={(input) => void act("review", async () => {
          await client.reviewScheduledTaskGrant(workspaceId, task.id, input);
        }, t("scheduled_tasks.authority_approved"))}
        onRevoke={() => void act("revoke", async () => {
          await client.revokeScheduledTaskGrant(workspaceId, task.id);
        }, t("scheduled_tasks.authority_revoked"))}
      />

      <RunHistory
        detail={detail}
        busyAction={busyAction}
        canExecute={capabilities.execute}
        onCancel={(runId) => void act(`cancel:${runId}`, async () => {
          await client.cancelScheduledTaskRun(workspaceId, task.id, runId);
        }, t("scheduled_tasks.run_cancelled"))}
        onDownloadReceipt={(runId) => void downloadReceipt(runId)}
        onOpenSession={(sessionId) => navigate(workspaceSessionRoute(routeWorkspaceId, sessionId))}
        onOpenArtifact={(runId, artifact) => void openArtifact(runId, artifact)}
      />
      <ConfirmModal
        open={deleteConfirmOpen}
        title={t("scheduled_tasks.delete_confirm_title")}
        message={t("scheduled_tasks.delete_confirm_copy")}
        confirmLabel={t("scheduled_tasks.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          void act("delete", async () => {
            await client.deleteScheduledTask(workspaceId, task.id);
            onBack();
          }, t("scheduled_tasks.deleted"));
        }}
      />
    </div>
  );
}

export function ScheduledTasksControlActions({
  client,
  workspaceId,
  routeWorkspaceId,
}: {
  client: ScheduledTasksClient | null;
  workspaceId: string;
  routeWorkspaceId: string;
}) {
  const navigate = useNavigate();
  const listAction = useMemo<OpenworkControlAction>(() => ({
    id: "scheduled_tasks.list",
    label: "List Scheduled Tasks",
    description: "Read Scheduled Tasks and their current state in the active workspace.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    disabled: !client || !workspaceId,
    execute: async () => client?.listScheduledTasks(workspaceId),
  }), [client, workspaceId]);
  useControlAction(listAction);

  const openAction = useMemo<OpenworkControlAction>(() => ({
    id: "scheduled_tasks.open",
    label: "Open Scheduled Tasks",
    description: "Navigate to Scheduled Tasks, or to a specific task when taskId is provided.",
    sideEffect: "navigation",
    disabled: !routeWorkspaceId,
    args: [{ name: "taskId", type: "string", required: false }],
    execute: (args) => {
      const value = args && typeof args === "object" ? Reflect.get(args, "taskId") : null;
      const taskId = typeof value === "string" ? value : null;
      navigate(scheduledTasksRoute(routeWorkspaceId, taskId));
      return { taskId };
    },
  }), [navigate, routeWorkspaceId]);
  useControlAction(openAction);

  const createAction = useMemo<OpenworkControlAction>(() => ({
    id: "scheduled_tasks.open_create",
    label: "Open new Scheduled Task",
    description: "Open the disabled Scheduled Task draft editor for human review.",
    sideEffect: "navigation",
    disabled: !routeWorkspaceId,
    execute: () => {
      navigate(scheduledTasksCreateRoute(routeWorkspaceId));
      return { state: "draft", enabled: false };
    },
  }), [navigate, routeWorkspaceId]);
  useControlAction(createAction);

  const openSessionAction = useMemo<OpenworkControlAction>(() => ({
    id: "scheduled_tasks.open_session",
    label: "Open a Scheduled Task run session",
    description: "Open the exact user-owned session created for a Scheduled Task run.",
    sideEffect: "navigation",
    disabled: !routeWorkspaceId,
    requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true }],
    execute: (args) => {
      const value = args && typeof args === "object" ? Reflect.get(args, "sessionId") : null;
      if (typeof value !== "string" || !value.trim()) return { ok: false, error: "sessionId is required" };
      navigate(workspaceSessionRoute(routeWorkspaceId, value));
      return { sessionId: value };
    },
  }), [navigate, routeWorkspaceId]);
  useControlAction(openSessionAction);

  const openArtifactAction = useMemo<OpenworkControlAction>(() => ({
    id: "scheduled_tasks.open_artifact",
    label: "Open a Scheduled Task run artifact",
    description: "Open the exact artifact recorded on a Scheduled Task run receipt.",
    sideEffect: "external",
    requiresArgs: true,
    disabled: !client || !workspaceId,
    args: [
      { name: "taskId", type: "string", required: true },
      { name: "runId", type: "string", required: true },
      { name: "artifactId", type: "string", required: true },
    ],
    execute: async (args) => {
      const taskValue = args && typeof args === "object" ? Reflect.get(args, "taskId") : null;
      const runValue = args && typeof args === "object" ? Reflect.get(args, "runId") : null;
      const artifactValue = args && typeof args === "object" ? Reflect.get(args, "artifactId") : null;
      if (
        typeof taskValue !== "string"
        || typeof runValue !== "string"
        || typeof artifactValue !== "string"
      ) {
        return { ok: false, error: "taskId, runId, and artifactId are required" };
      }
      const receipt = await client!.getScheduledTaskRunReceipt(workspaceId, taskValue, runValue);
      const artifact = receipt.artifacts.find((candidate) => candidate.id === artifactValue);
      if (!artifact) return { ok: false, error: "Artifact is not present on this run receipt" };
      if (artifact.kind === "url") {
        window.open(artifact.value, "_blank", "noopener,noreferrer");
      } else {
        const result = await client!.downloadScheduledTaskArtifact(
          workspaceId,
          taskValue,
          runValue,
          artifact.id,
        );
        downloadBlob(
          result.data,
          artifact.name ?? artifact.value.split("/").at(-1) ?? "artifact",
          result.contentType,
        );
      }
      return { artifact };
    },
  }), [client, workspaceId]);
  useControlAction(openArtifactAction);

  const tickAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.scheduled_tasks.tick",
      label: "Tick Scheduled Tasks scheduler",
      description: "Deterministically process due Scheduled Tasks in development and coded evals.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      args: [{ name: "now", type: "number", required: false }],
      execute: async (args) => {
        const value = args && typeof args === "object" ? Reflect.get(args, "now") : null;
        return client?.tickScheduledTaskScheduler(workspaceId, typeof value === "number" ? value : undefined);
      },
    };
  }, [client, workspaceId]);
  useControlAction(tickAction);
  return null;
}

export function ScheduledTasksPage(props: ScheduledTasksPageProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const creating = !props.taskId && searchParams.get("create") === "1";
  const suggestionId = SCHEDULED_TASK_SUGGESTIONS.some((suggestion) => suggestion.id === searchParams.get("template"))
    ? searchParams.get("template") as ScheduledTaskSuggestionId
    : null;
  const [createBusy, setCreateBusy] = useState(false);
  const requestedCreateWorkspaceId = searchParams.get("workspace")?.trim() || null;
  const requestedWorkspaceId = props.taskWorkspaceId ?? requestedCreateWorkspaceId;
  const selectedTarget = requestedWorkspaceId
    ? props.targets.find((target) => target.routeWorkspaceId === requestedWorkspaceId) ?? null
    : props.targets[0] ?? null;

  const targetListQueries = useQueries({
    queries: props.targets.map((target) => ({
      queryKey: ["scheduled-tasks", target.client.baseUrl, target.workspaceId],
      enabled: !creating,
      queryFn: async () => {
        const capabilities = (await target.client.capabilities()).scheduledTasks;
        if (!capabilities?.read) return { target, capabilities, items: [] as ScheduledTaskListItem[] };
        const result = await target.client.listScheduledTasks(target.workspaceId);
        return { target, capabilities, items: result.items };
      },
      refetchInterval: 10_000,
    })),
  });
  const listEntries = targetListQueries.flatMap((query) => query.data?.items.map((item) => ({ item, target: query.data!.target })) ?? []);
  const listCanWrite = targetListQueries.some((query) => query.data?.capabilities?.write === true);
  const firstWritableTarget = targetListQueries.find((query) => query.data?.capabilities?.write === true)?.data?.target
    ?? selectedTarget;

  const capabilitiesQuery = useQuery({
    queryKey: ["scheduled-tasks-capabilities", selectedTarget?.client.baseUrl],
    enabled: Boolean(selectedTarget),
    queryFn: () => selectedTarget!.client.capabilities(),
  });
  const capabilities = capabilitiesQuery.data?.scheduledTasks;
  const detailQuery = useQuery({
    queryKey: ["scheduled-task", selectedTarget?.client.baseUrl, selectedTarget?.workspaceId, props.taskId],
    enabled: Boolean(selectedTarget && capabilities?.read && props.taskId),
    queryFn: () => selectedTarget!.client.getScheduledTask(selectedTarget!.workspaceId, props.taskId!),
    refetchInterval: 5_000,
  });

  const openList = () => navigate(scheduledTasksRoute());
  const openTask = (workspaceId: string, taskId: string) => navigate(scheduledTasksRoute(workspaceId, taskId));
  const openCreate = () => navigate(scheduledTasksCreateRoute(firstWritableTarget?.routeWorkspaceId));
  const openCreateSuggestion = (template: ScheduledTaskSuggestionId) => navigate(scheduledTasksCreateRoute(firstWritableTarget?.routeWorkspaceId, template));

  if (props.targets.length === 0 || !selectedTarget) {
    return <UnavailableState reason={t("scheduled_tasks.server_unavailable")} />;
  }
  const needsSelectedAccess = creating || Boolean(props.taskId);
  if (needsSelectedAccess && capabilitiesQuery.isLoading) return <LoadingState />;
  if (needsSelectedAccess && capabilitiesQuery.error) {
    return <ErrorState error={capabilitiesQuery.error} onRetry={() => void capabilitiesQuery.refetch()} />;
  }
  if (needsSelectedAccess && !capabilities) {
    return <UnavailableState reason={t("scheduled_tasks.upgrade_required")} />;
  }
  if (needsSelectedAccess && !capabilities?.read) {
    return <UnavailableState reason={t("scheduled_tasks.read_unavailable")} />;
  }

  if (creating) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-6 sm:px-6 sm:py-8" data-testid="scheduled-task-create-view">
          <Button variant="ghost" size="sm" className="-ms-2" onClick={openList}>
            <ArrowLeft aria-hidden="true" />
            {t("scheduled_tasks.title")}
          </Button>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">{t("scheduled_tasks.create_title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("scheduled_tasks.create_copy")}</p>
          </div>
          <div className="grid gap-4 rounded-2xl border border-border p-5 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)] sm:items-end">
            <div>
              <p className="text-sm font-medium">{t("scheduled_tasks.workspace")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("scheduled_tasks.workspace_hint")}</p>
            </div>
            <div className="space-y-2">
              <Label className="sr-only" htmlFor="scheduled-task-workspace">{t("scheduled_tasks.workspace")}</Label>
              <select
                id="scheduled-task-workspace"
                data-testid="scheduled-task-workspace"
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
                value={selectedTarget.routeWorkspaceId}
                onChange={(event) => {
                  navigate(scheduledTasksCreateRoute(event.currentTarget.value, suggestionId));
                }}
              >
                {props.targets.map((target) => (
                  <option key={target.routeWorkspaceId} value={target.routeWorkspaceId}>{target.workspaceLabel}</option>
                ))}
              </select>
            </div>
          </div>
          <ScheduledTaskEditor
            key={`${selectedTarget.workspaceId}:${suggestionId ?? "blank"}`}
            workspaceId={selectedTarget.workspaceId}
            initial={suggestionId ? suggestionDefinition(selectedTarget.workspaceId, suggestionId) : undefined}
            busy={createBusy}
            submitLabel={t("scheduled_tasks.save_draft")}
            onCancel={openList}
            onPreview={async (schedule) => (await selectedTarget.client.previewScheduledTaskSchedule(selectedTarget.workspaceId, { schedule })).preview}
            onSave={async (definition: ScheduledTaskDefinition) => {
              setCreateBusy(true);
              try {
                const result = await selectedTarget.client.createScheduledTaskDraft(selectedTarget.workspaceId, definition);
                await queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
                toast.success(t("scheduled_tasks.draft_created"));
                openTask(selectedTarget.routeWorkspaceId, result.task.id);
              } catch (error) {
                toast.error(describeError(error));
              } finally {
                setCreateBusy(false);
              }
            }}
          />
        </div>
      </div>
    );
  }

  const listLoading = targetListQueries.some((query) => query.isLoading) && listEntries.length === 0;
  const listError = targetListQueries.length > 0 && targetListQueries.every((query) => query.error)
    ? targetListQueries.find((query) => query.error)?.error
    : null;
  const listPane = listLoading ? <LoadingState />
    : listError ? <ErrorState error={listError} onRetry={() => void Promise.all(targetListQueries.map((query) => query.refetch()))} />
    : (
      <ScheduledTaskList
        items={listEntries}
        selectedTaskId={props.taskId}
        selectedWorkspaceId={props.taskWorkspaceId}
        canWrite={listCanWrite}
        onCreate={openCreate}
        onCreateSuggestion={openCreateSuggestion}
        onOpen={openTask}
      />
    );

  const detailPane = props.taskId ? (
    detailQuery.isLoading ? <LoadingState /> :
    detailQuery.error ? <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> :
    detailQuery.data ? (
          <ScheduledTaskDetailView
            detail={detailQuery.data}
            routeWorkspaceId={selectedTarget.routeWorkspaceId}
            workspaceId={selectedTarget.workspaceId}
            workspaceLabel={selectedTarget.workspaceLabel}
            workspaceRoot={selectedTarget.workspaceRoot}
            client={selectedTarget.client}
            capabilities={capabilities!}
            onBack={openList}
            onOpenTask={(taskId) => openTask(selectedTarget.routeWorkspaceId, taskId)}
          />
    ) : <ErrorState error={new Error(t("scheduled_tasks.error_not_found"))} onRetry={() => void detailQuery.refetch()} />
  ) : (
    <div className="flex min-h-full items-center justify-center p-8">
      <Empty className="max-w-lg flex-none border-0">
        <EmptyHeader className="w-full">
          <EmptyMedia variant="icon"><Clock3 aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>{t("scheduled_tasks.select_title")}</EmptyTitle>
          <EmptyDescription>{t("scheduled_tasks.select_copy")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button disabled={!listCanWrite} onClick={openCreate}>
            <Plus aria-hidden="true" />
            {t("scheduled_tasks.create")}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]" data-testid="scheduled-tasks-master-detail">
      <aside className={cn("min-h-0 overflow-y-auto bg-background/20 lg:border-e lg:border-border", props.taskId ? "hidden lg:block" : "block")}>
        {listPane}
      </aside>
      <section className={cn("min-h-0 overflow-y-auto", props.taskId ? "block" : "hidden lg:block")} aria-label={t("scheduled_tasks.task_detail")}>
        {detailPane}
      </section>
    </div>
  );
}
