import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type { TaskCenterItem, TaskCenterStatus, TaskCenterStage } from "../types";
import type { ParsedTask } from "../lib/tasks-parser";
import { formatRelativeTime } from "../utils";
import { usePlatform } from "../context/platform";

import Button from "../components/button";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  X,
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

// Task status display helpers
const taskStatusIcon = (status: ParsedTask["status"]) => {
  switch (status) {
    case "pending": return <Circle size={14} class="text-gray-6" />;
    case "in-progress": return <Loader2 size={14} class="text-amber-6 animate-spin" />;
    case "completed": return <CheckCircle2 size={14} class="text-emerald-6" />;
    case "failed": return <X size={14} class="text-red-6" />;
    default: return <Circle size={14} class="text-gray-6" />;
  }
};

const taskStatusText = (status: ParsedTask["status"]) => {
  switch (status) {
    case "pending": return "待执行";
    case "in-progress": return "执行中";
    case "completed": return "已完成";
    case "failed": return "失败";
    default: return "待执行";
  }
};

export type TaskCenterViewProps = {
  itemsByStatus: Record<TaskCenterStatus, TaskCenterItem[]>;
  status: "idle" | "syncing" | "error";
  error: string | null;
  syncing: boolean;
  lastUpdatedAt: number | null;
  syncTasks: (options?: { force?: boolean }) => void;
  startAutomation: (item: TaskCenterItem) => void;
  // Task execution props
  selectedItem?: TaskCenterItem | null;
  tasks?: ParsedTask[];
  currentTaskIndex?: number;
  executing?: boolean;
  onSelectItem?: (item: TaskCenterItem | null) => void;
  onExecuteTask?: (item: TaskCenterItem, taskIndex: number) => void;
  onCompleteTask?: (item: TaskCenterItem, taskIndex: number) => void;
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

// Task Execution Panel Component
function TaskExecutionPanel(props: {
  item: TaskCenterItem;
  tasks: ParsedTask[];
  currentTaskIndex: number;
  executing: boolean;
  onClose: () => void;
  onExecuteTask: (taskIndex: number) => void;
  onCompleteTask: (taskIndex: number) => void;
}) {
  const [expandedTask, setExpandedTask] = createSignal<number | null>(null);

  const canExecute = (task: ParsedTask, index: number) => {
    // Can execute if task is pending and it's the current task or all previous are completed
    if (task.status !== "pending") return false;
    if (index === 0) return true;
    return props.tasks.slice(0, index).every(t => t.status === "completed");
  };

  const canComplete = (task: ParsedTask, index: number) => {
    return task.status === "in-progress" && index === props.currentTaskIndex;
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-lg max-h-[80vh] overflow-hidden rounded-2xl border border-dls-border bg-dls-surface shadow-xl flex flex-col">
        {/* Header */}
        <div class="flex items-center justify-between border-b border-dls-border px-4 py-3">
          <div>
            <h3 class="text-sm font-semibold text-dls-text">执行计划</h3>
            <p class="text-[11px] text-dls-secondary">#{props.item.tfsId} · {props.item.title}</p>
          </div>
          <button
            onClick={props.onClose}
            class="rounded-full p-1 text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
          >
            <X size={18} />
          </button>
        </div>

        {/* Task List */}
        <div class="flex-1 overflow-y-auto p-4 space-y-2">
          <For each={props.tasks}>
            {(task, index) => {
              const isExpanded = () => expandedTask() === index();
              const canExec = () => canExecute(task, index());
              const canComp = () => canComplete(task, index());

              return (
                <div
                  class={`rounded-xl border p-3 transition-colors ${
                    task.status === "in-progress"
                      ? "border-amber-6/40 bg-amber-1/20"
                      : task.status === "completed"
                      ? "border-emerald-6/40 bg-emerald-1/20"
                      : task.status === "failed"
                      ? "border-red-6/40 bg-red-1/20"
                      : "border-dls-border bg-dls-surface"
                  }`}
                >
                  {/* Task Header */}
                  <div class="flex items-start gap-3">
                    <div class="mt-0.5 flex-shrink-0">
                      {taskStatusIcon(task.status)}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-sm font-medium text-dls-text truncate">
                          Task {index() + 1}: {task.title}
                        </span>
                        <span class="text-[10px] text-dls-secondary whitespace-nowrap">
                          {taskStatusText(task.status)}
                        </span>
                      </div>

                      {/* Action Buttons */}
                      <div class="mt-2 flex items-center gap-2">
                        <Show when={canExec() && !props.executing}>
                          <Button
                            variant="primary"
                            class="h-6 px-2 text-[10px]"
                            onClick={() => props.onExecuteTask(index())}
                          >
                            <Play size={10} />
                            开始执行
                          </Button>
                        </Show>
                        <Show when={canComp() && !props.executing}>
                          <Button
                            variant="outline"
                            class="h-6 px-2 text-[10px]"
                            onClick={() => props.onCompleteTask(index())}
                          >
                            <CheckCircle2 size={10} />
                            标记完成
                          </Button>
                        </Show>
                        <Show when={props.executing && index() === props.currentTaskIndex}>
                          <span class="text-[10px] text-amber-6 flex items-center gap-1">
                            <Loader2 size={10} class="animate-spin" />
                            执行中...
                          </span>
                        </Show>
                      </div>
                    </div>
                    <button
                      onClick={() => setExpandedTask(isExpanded() ? null : index())}
                      class="rounded p-1 text-dls-secondary hover:text-dls-text hover:bg-dls-hover flex-shrink-0"
                    >
                      {isExpanded() ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  </div>

                  {/* Expanded Description */}
                  <Show when={isExpanded()}>
                    <div class="mt-2 pl-6 text-[11px] text-dls-secondary border-t border-dls-border pt-2">
                      <p class="whitespace-pre-wrap">{task.description || "暂无描述"}</p>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        {/* Footer */}
        <div class="border-t border-dls-border px-4 py-3 bg-dls-hover/50">
          <div class="flex items-center justify-between text-[11px] text-dls-secondary">
            <span>
              进度: {props.tasks.filter(t => t.status === "completed").length} / {props.tasks.length}
            </span>
            <Show when={props.tasks.every(t => t.status === "completed")}>
              <span class="text-emerald-6 font-medium">✓ 所有任务已完成</span>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TaskCenterView(props: TaskCenterViewProps) {
  const platform = usePlatform();
  const lastUpdatedLabel = createMemo(() => toLabel(props.lastUpdatedAt));

  // Local state for task execution panel
  const [showTaskPanel, setShowTaskPanel] = createSignal(false);
  const [selectedItem, setSelectedItem] = createSignal<TaskCenterItem | null>(null);

  onMount(() => {
    const interval = window.setInterval(() => props.syncTasks(), 60_000);
    onCleanup(() => window.clearInterval(interval));
  });

  const handleStartAutomation = (item: TaskCenterItem) => {
    setSelectedItem(item);
    setShowTaskPanel(true);
    props.startAutomation(item);
  };

  const handleClosePanel = () => {
    setShowTaskPanel(false);
    setSelectedItem(null);
  };

  const handleExecuteTask = (taskIndex: number) => {
    const item = selectedItem();
    if (item && props.onExecuteTask) {
      props.onExecuteTask(item, taskIndex);
    }
  };

  const handleCompleteTask = (taskIndex: number) => {
    const item = selectedItem();
    if (item && props.onCompleteTask) {
      props.onCompleteTask(item, taskIndex);
    }
  };

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

      {/* Task Execution Panel Modal */}
      <Show when={showTaskPanel() && selectedItem()}>
        <TaskExecutionPanel
          item={selectedItem()!}
          tasks={props.tasks ?? []}
          currentTaskIndex={props.currentTaskIndex ?? -1}
          executing={props.executing ?? false}
          onClose={handleClosePanel}
          onExecuteTask={handleExecuteTask}
          onCompleteTask={handleCompleteTask}
        />
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

                          {/* Action buttons based on status */}
                          <Show when={item.status === "todo"}>
                            <div class="mt-4">
                              <Button
                                variant="primary"
                                class="h-8 px-3 text-xs"
                                onClick={() => handleStartAutomation(item)}
                              >
                                <Play size={12} />
                                生成计划
                              </Button>
                            </div>
                          </Show>

                          <Show when={item.status === "progress" || item.status === "done" || item.status === "failed"}>
                            <div class="mt-4">
                              <Button
                                variant="outline"
                                class="h-8 px-3 text-xs"
                                onClick={() => handleStartAutomation(item)}
                              >
                                <ExternalLink size={12} />
                                查看计划
                              </Button>
                            </div>
                          </Show>

                          <Show when={item.status === "archived"}>
                            <div class="mt-4">
                              <Button
                                variant="outline"
                                class="h-8 px-3 text-xs"
                                onClick={() => handleStartAutomation(item)}
                              >
                                <ExternalLink size={12} />
                                查看归档
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
