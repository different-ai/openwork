import { For, Show, createMemo, onCleanup, onMount } from "solid-js";

import type { TaskCenterItem, TaskCenterStatus, TaskCenterStage } from "../types";
import { formatRelativeTime } from "../utils";
import { usePlatform } from "../context/platform";

import Button from "../components/button";
import {
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
} from "lucide-solid";

// Stage labels mapping
const stageLabels: Record<TaskCenterStage, string> = {
  idle: "待处理",
  syncing: "同步中",
  analyzing: "分析",
  designing: "设计",
  planning: "计划",
  implementing: "实现",
  reviewing: "评审",
  archiving: "归档",
};

// SubStage labels mapping (only for implementing stage)
const subStageLabels: Record<string, string> = {
  "workspace-prep": "环境初始化",
  "plan-exec": "执行计划",
  "tests": "运行测试",
  "fixes": "修复问题",
  "ready-review": "待评审",
};

// Helper function to get stage label with optional subStage
const stageLabel = (stage?: TaskCenterStage, subStage?: string | null): string => {
  if (!stage || stage === "idle" || stage === "syncing") return "";
  
  const mainLabel = stageLabels[stage] || stage;
  
  // Only show subStage for implementing stage
  if (stage === "implementing" && subStage && subStageLabels[subStage]) {
    return `${mainLabel} · ${subStageLabels[subStage]}`;
  }
  
  return mainLabel;
};

export type TaskCenterViewProps = {
  itemsByStatus: Record<TaskCenterStatus, TaskCenterItem[]>;
  status: "idle" | "syncing" | "error";
  error: string | null;
  syncing: boolean;
  lastUpdatedAt: number | null;
  syncTasks: (options?: { force?: boolean }) => void;
  startAutomation: (item: TaskCenterItem) => void;
};

const STATUS_ORDER: TaskCenterStatus[] = ["todo", "progress", "done", "failed", "archived"];

const statusMeta: Record<TaskCenterStatus, { label: string; tone: string; badge: string }> = {
  todo: {
    label: "To do",
    tone: "border-gray-4 bg-gray-1 text-gray-10",
    badge: "bg-gray-3 text-gray-10",
  },
  progress: {
    label: "In progress",
    tone: "border-amber-6/60 bg-amber-1/60 text-amber-11",
    badge: "bg-amber-3 text-amber-11",
  },
  done: {
    label: "Done",
    tone: "border-emerald-6/60 bg-emerald-1/60 text-emerald-11",
    badge: "bg-emerald-3 text-emerald-11",
  },
  failed: {
    label: "Blocked",
    tone: "border-red-6/60 bg-red-1/60 text-red-11",
    badge: "bg-red-3 text-red-11",
  },
  archived: {
    label: "Archived",
    tone: "border-slate-6/60 bg-slate-1/60 text-slate-11",
    badge: "bg-slate-3 text-slate-11",
  },
};

const toLabel = (value?: number | null) => {
  if (!value) return "Not synced yet";
  return formatRelativeTime(value);
};

const tagLabel = (value: string) => value.replace(/\s+/g, " ").trim();

const cleanText = (value?: string) => {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
};

export default function TaskCenterView(props: TaskCenterViewProps) {
  const platform = usePlatform();
  const lastUpdatedLabel = createMemo(() => toLabel(props.lastUpdatedAt));

  onMount(() => {
    const interval = window.setInterval(() => props.syncTasks(), 60_000);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <section class="space-y-4">
      <div class="-mt-3 rounded-3xl border border-dls-border bg-dls-surface px-4 py-2 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-xs text-dls-secondary">
              Sync your TFS work items and drive them through OpenWork automations.
            </p>
          </div>
          <div class="flex flex-col gap-3 sm:items-end">
            <Button
              variant="outline"
              class="h-8 px-3 text-[11px]"
              disabled={props.syncing}
              onClick={() => props.syncTasks({ force: true })}
            >
              {props.syncing ? <Loader2 size={14} class="animate-spin" /> : <RefreshCw size={14} />}
              {props.syncing ? "Syncing" : "Refresh"} · Last sync: {lastUpdatedLabel()}
            </Button>
          </div>
        </div>
      </div>

      <Show when={props.error}>
        <div class="rounded-2xl border border-red-7/40 bg-red-3/60 px-5 py-4 text-sm text-red-11">
          {props.error}
        </div>
      </Show>

      <div class="flex gap-4 overflow-x-auto pb-4 h-[calc(100vh-180px)] md:h-[calc(100vh-220px)]">
        <For each={STATUS_ORDER}>
          {(status) => {
            const items = () => props.itemsByStatus[status] ?? [];
            const meta = statusMeta[status];
            return (
              <div class="min-w-[260px] max-w-[320px] flex-1 flex flex-col min-h-0">
                <div class={`rounded-2xl border px-4 py-3 ${meta.tone}`}>
                  <div class="flex items-center justify-between">
                    <div class="text-sm font-semibold">{meta.label}</div>
                    <span class={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${meta.badge}`}>
                      {items().length}
                    </span>
                  </div>
                </div>
                <div class="mt-3 flex-1 min-h-0 space-y-3 overflow-y-auto pr-1">
                  <Show
                    when={items().length > 0}
                    fallback={
                      <div class="rounded-2xl border border-dls-border bg-dls-surface px-4 py-6 text-xs text-dls-secondary">
                        No tasks in {meta.label.toLowerCase()}.
                      </div>
                    }
                  >
                    <For each={items()}>
                      {(item) => (
                        <div class="rounded-2xl border border-dls-border bg-dls-surface px-4 py-4 shadow-sm">
                          <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                              <div class="text-sm font-semibold text-dls-text truncate">
                                {item.title}
                              </div>
                              <div class="mt-1 text-[11px] text-dls-secondary">
                                #{item.tfsId}
                                {item.project ? ` · ${item.project}` : ""}
                                {item.workItemType ? ` · ${item.workItemType}` : ""}
                              </div>
                            </div>
                            <Show when={item.url}>
                              <button
                                type="button"
                                onClick={() => item.url && platform.openLink(item.url)}
                                class="rounded-full p-1 text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                                title="Open in TFS"
                              >
                                <ExternalLink size={14} />
                              </button>
                            </Show>
                          </div>

                          <Show when={cleanText(item.description)}>
                            <p class="mt-2 text-xs text-dls-secondary line-clamp-3">
                              {cleanText(item.description)}
                            </p>
                          </Show>

                          {/* Stage badge - only show for non-idle stages */}
                          <Show when={item.stage && item.stage !== "idle" && item.stage !== "syncing"}>
                            <div class="mt-2">
                              <span class="inline-flex items-center rounded-full bg-blue-3 px-2 py-0.5 text-[10px] font-medium text-blue-11">
                                {stageLabel(item.stage, item.subStage)}
                              </span>
                            </div>
                          </Show>

                          <div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
                            <Show when={item.priority}>
                              <span class="rounded-full border border-dls-border px-2 py-0.5">
                                P{item.priority}
                              </span>
                            </Show>
                            <Show when={item.assignedTo}>
                              <span class="rounded-full border border-dls-border px-2 py-0.5">
                                {item.assignedTo}
                              </span>
                            </Show>
                            <Show when={item.state}>
                              <span class="rounded-full border border-dls-border px-2 py-0.5">
                                {item.state}
                              </span>
                            </Show>
                            <Show when={item.updatedAt}>
                              <span>{formatRelativeTime(item.updatedAt ?? Date.now())}</span>
                            </Show>
                          </div>

                          <Show when={item.tags?.length}>
                            <div class="mt-3 flex flex-wrap gap-1">
                              <For each={item.tags ?? []}>
                                {(tag) => (
                                  <span class="rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 text-[10px] text-dls-secondary">
                                    {tagLabel(tag)}
                                  </span>
                                )}
                              </For>
                            </div>
                          </Show>

                          <Show when={item.status === "todo"}>
                            <div class="mt-4">
                              <Button
                                variant="ghost"
                                class="h-8 px-3 text-xs"
                                onClick={() => props.startAutomation(item)}
                              >
                                <Play size={12} />
                                Run automation
                              </Button>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </section>
  );
}
