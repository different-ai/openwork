import { createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import type { Client, TaskCenterItem, TaskCenterStatus, TaskCenterStage, TaskCenterAutomationState } from "../types";
import { Persist, persisted } from "../utils/persist";
import { unwrap } from "../lib/opencode";
import { parseTasks, updateTaskStatus, type ParsedTask } from "../lib/tasks-parser";

// Use Record instead of Map for JSON serialization compatibility
export type AutomationStateMap = Record<number, TaskCenterAutomationState>;

// Helper to safely get value from Record
export function getAutomationState(record: AutomationStateMap, tfsId: number): TaskCenterAutomationState | undefined {
  return record[tfsId];
}

// Merge automation state with TFS items
// Merge TFS items with automation state - preserves automation items not in TFS query
export function mergeTfsItemsWithAutomation(
  tfsItems: TaskCenterItem[],
  automation: AutomationStateMap
): TaskCenterItem[] {
  const result: TaskCenterItem[] = [];
  const processedTfsIds = new Set<number>();

  // First, process all TFS items and merge with automation
  for (const item of tfsItems) {
    const autoState = getAutomationState(automation, item.tfsId);
    if (autoState) {
      // Merge automation state into TFS item
      result.push({
        ...item,
        status: autoState.status,
        stage: autoState.stage,
      });
    } else {
      // No automation state, use TFS item as-is
      result.push(item);
    }
    processedTfsIds.add(item.tfsId);
  }

  // Then, add automation items that are not in TFS query result
  for (const [key, autoState] of Object.entries(automation)) {
    const tfsId = Number(key);
    if (!Number.isNaN(tfsId) && !processedTfsIds.has(tfsId) && autoState) {
      // Create a TaskCenterItem from automation state
      result.push({
        id: `tfs-${tfsId}`,
        tfsId,
        title: `Work Item #${tfsId}`, // Placeholder, should be loaded from storage
        status: autoState.status,
        stage: autoState.stage,
        updatedAt: autoState.updatedAt,
      });
    }
  }

  return result;
}

export function mergeAutomationState(
  tfsItems: Array<{ tfsId: number; status: TaskCenterStatus }>,
  automation: AutomationStateMap
): AutomationStateMap {
  const result: AutomationStateMap = {};

  for (const item of tfsItems) {
    const existing = getAutomationState(automation, item.tfsId);

    if (existing) {
      // Check if TFS is in a final state (done/archived) - use TFS state
      const isTfsFinal = item.status === "done" || item.status === "archived";

      result[item.tfsId] = {
        ...existing,
        status: isTfsFinal ? item.status : existing.status,
        updatedAt: Date.now()
      };
    } else {
      // No automation state: create from TFS item
      result[item.tfsId] = {
        status: item.status,
        stage: "idle" as TaskCenterStage,
        updatedAt: Date.now()
      };
    }
  }

  return result;
}

export type TaskCenterStore = ReturnType<typeof createTaskCenterStore>;

type SyncStatus = "idle" | "syncing" | "error";

type TaskCenterUiState = {
  search: string;
};

function mapStateToStatus(state?: string | null): TaskCenterStatus {
  const normalized = (state ?? "").trim();
  if (normalized === "活动") return "progress";
  if (normalized === "已解决") return "done";
  if (normalized === "已关闭") return "archived";
  // Only "已分析" should map to "todo"
  if (normalized === "已分析") return "todo";
  // Other states like "已建议" should not appear in Task Center
  // (they will be filtered out by TFS query)
  return "todo";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readErrorMessage = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return null;
};

const extractOutputFromParts = (parts: unknown): string | null => {
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === "tool") {
      const state = isRecord(part.state) ? part.state : null;
      if (state) {
        if (state.status === "error") {
          const message = readErrorMessage(state.error);
          if (message) throw new Error(message);
        }
        if (typeof state.output === "string") return state.output;
        const metadata = isRecord(state.metadata) ? state.metadata : null;
        if (metadata && typeof metadata.output === "string") return metadata.output;
      }
    }
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  return null;
};

function extractOutput(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === "string") return result;
  if (!isRecord(result)) return null;
  const errorMessage = readErrorMessage(result.error);
  if (errorMessage) throw new Error(errorMessage || "Unknown error");

  const partsOutput = extractOutputFromParts(result.parts);
  if (partsOutput) return partsOutput;

  if (typeof result.output === "string") return result.output;
  if (typeof result.stdout === "string") return result.stdout;
  if (typeof result.data === "string") return result.data;

  if (isRecord(result.data)) {
    const dataError = readErrorMessage(result.data.error);
    if (dataError) throw new Error(dataError || "Unknown error");
    const dataParts = extractOutputFromParts(result.data.parts);
    if (dataParts) return dataParts;
    if (typeof result.data.output === "string") return result.data.output;
    if (typeof result.data.stdout === "string") return result.data.stdout;
  }
  return null;
}

function parseWorkItems(raw: string): TaskCenterItem[] {
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  return parsed
    .filter((item) => typeof item?.id === "number")
    .map((item) => {
      const state = typeof item.state === "string" ? item.state : null;
      const changedDate = typeof item.changedDate === "string" ? item.changedDate : null;
      const updatedAt = changedDate ? Date.parse(changedDate) : null;
      const tfsId = item.id as number;
      return {
        id: `tfs-${tfsId}`,
        tfsId,
        title: typeof item.title === "string" ? item.title : "Untitled",
        description: typeof item.description === "string" ? item.description : undefined,
        project: typeof item.project === "string" ? item.project : null,
        workItemType: typeof item.workItemType === "string" ? item.workItemType : null,
        priority: typeof item.priority === "number" ? item.priority : null,
        assignedTo: typeof item.assignedTo === "string" ? item.assignedTo : null,
        tags: Array.isArray(item.tags) ? (item.tags as string[]) : [],
        state,
        url: typeof item.url === "string" ? item.url : null,
        status: mapStateToStatus(state),
        stage: "syncing",
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
      } satisfies TaskCenterItem;
    });
}

export function createTaskCenterStore(options: {
  client: () => Client | null;
  activeWorkspaceRoot: () => string;
  createSessionAndOpen: () => void;
  setPrompt: (value: string) => void;
}) {
  const [items, setItems] = createSignal<TaskCenterItem[]>([]);
  const [status, setStatus] = createSignal<SyncStatus>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = createSignal<number | null>(null);
  const [syncing, setSyncing] = createSignal(false);
  const [syncSessionId, setSyncSessionId] = createSignal<string | null>(null);
  
  // Task execution state
  const [selectedItem, setSelectedItem] = createSignal<TaskCenterItem | null>(null);
  const [tasks, setTasks] = createSignal<ParsedTask[]>([]);
  const [currentTaskIndex, setCurrentTaskIndex] = createSignal<number>(-1);
  const [executing, setExecuting] = createSignal(false);

  // Automation state store - persists automation progress
  // Using Record instead of Map for JSON serialization compatibility
  const automationStore = (() => {
    const initialState: AutomationStateMap = {};
    const store = createStore<AutomationStateMap>(initialState);
    return persisted(Persist.global("task-center.automation"), store);
  })();
  const automationState = automationStore[0];
  const setAutomationState = (tfsId: number, state: TaskCenterAutomationState) => {
    const updater: Partial<AutomationStateMap> = {};
    updater[tfsId] = state;
    automationStore[1](updater);
  };

  const uiStore = (() => {
    const store = createStore<TaskCenterUiState>({
      search: "",
    });
    return persisted(Persist.global("task-center.ui"), store);
  })();
  const ui = uiStore[0];
  const setUi = uiStore[1];

  const filteredItems = createMemo(() => {
    const uiState = ui;
    if (!uiState) return items();
    const query = uiState.search?.trim().toLowerCase() ?? "";
    if (!query) return items();
    return items().filter((item) => {
      const haystack = `${item.title ?? ""} ${item.project ?? ""} ${item.workItemType ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  const itemsByStatus = createMemo(() => {
    const grouped: Record<TaskCenterStatus, TaskCenterItem[]> = {
      todo: [],
      progress: [],
      done: [],
      archived: [],
      failed: [],
    };
    for (const item of filteredItems()) {
      grouped[item.status].push(item);
    }
    return grouped;
  });

  const setSearch = (value: string) => setUi("search", value);

  const syncTasks = async (syncOptions?: { force?: boolean }) => {
    if (syncing() && !syncOptions?.force) return;
    const activeClient = options.client();
    if (!activeClient) {
      setError("Not connected to OpenCode.");
      setStatus("error");
      return;
    }

    const directory = options.activeWorkspaceRoot().trim();
    const command = "node .opencode/skills/tfs2018-integration/tools/task-center-integration.mjs list-json";

    setSyncing(true);
    setStatus("syncing");
    setError(null);

    try {
      const sessionApi = activeClient.session as typeof activeClient.session & {
        shellAsync?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
        shell?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
      };

      let sessionID = syncSessionId();
      if (!sessionID) {
        const result = await sessionApi.create({ directory: directory || undefined });
        const session = unwrap(result);
        sessionID = session.id;
        setSyncSessionId(sessionID);
      }

      const shellInput = {
        sessionID,
        command,
        agent: "openwork",
        directory: directory || undefined,
      };
      const result = sessionApi.shellAsync
        ? await sessionApi.shellAsync(shellInput)
        : sessionApi.shell
          ? await sessionApi.shell(shellInput)
          : null;

      if (!result) {
        throw new Error("Shell execution is unavailable for task sync.");
      }

      const output = extractOutput(result);
      const trimmed = output?.trim();
      if (!trimmed) {
        throw new Error("Task sync returned no output.");
      }
      if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
        throw new Error(trimmed);
      }

      const tfsItems = parseWorkItems(trimmed).map((item) => ({
        ...item,
        stage: "idle" as TaskCenterStage,
      }));
      
      // Merge with automation state to preserve items not in TFS query
      const mergedItems = mergeTfsItemsWithAutomation(tfsItems, automationState ?? {});
      setItems(mergedItems);
      setLastUpdatedAt(Date.now());
      setStatus("idle");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task sync failed.";
      setError(message);
      setStatus("error");
    } finally {
      setSyncing(false);
    }
  };

  const startAutomation = async (item: TaskCenterItem) => {
    const activeClient = options.client();
    if (!activeClient) {
      setError("Not connected to OpenCode.");
      return;
    }

    const directory = options.activeWorkspaceRoot().trim();
    const tfsId = item.tfsId;

    try {
      // Step 1: Update TFS state to "活动" via shell command
      const activateCommand = `node .opencode/skills/tfs2018-integration/tools/task-center-integration.mjs activate ${tfsId}`;
      
      const sessionApi = activeClient.session as typeof activeClient.session & {
        shellAsync?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
        shell?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
      };

      // Create a temporary session for TFS operations
      const result = await sessionApi.create({ directory: directory || undefined });
      const session = unwrap(result);
      const sessionID = session.id;

      const shellInput = {
        sessionID,
        command: activateCommand,
        agent: "openwork",
        directory: directory || undefined,
      };

      const shellResult = sessionApi.shellAsync
        ? await sessionApi.shellAsync(shellInput)
        : sessionApi.shell
          ? await sessionApi.shell(shellInput)
          : null;

      if (!shellResult) {
        throw new Error("Shell execution is unavailable for TFS state update.");
      }

      const output = extractOutput(shellResult);
      if (!output?.includes("activated successfully")) {
        console.warn("TFS activation may have failed:", output);
      }

      // Step 2: Update local automation state
      setAutomationState(tfsId, {
        status: "progress",
        stage: "analyzing",
        subStage: null,
        sessionId: null,
        blockedReason: null,
        updatedAt: Date.now(),
      });

      // Step 3: Create OpenCode session with task-automation prompt
      const prompt = `使用 task-automation skill 完整处理 TFS 工作项 #${item.tfsId}。`;
      options.setPrompt(prompt);
      options.createSessionAndOpen();

    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start automation.";
      setError(message);
      console.error("Start automation error:", error);
    }
  };

  // Task execution functions
  const selectItem = (item: TaskCenterItem | null) => {
    setSelectedItem(item);
    if (item) {
      loadTasks(item);
    } else {
      setTasks([]);
      setCurrentTaskIndex(-1);
    }
  };

  const loadTasks = async (item: TaskCenterItem) => {
    const activeClient = options.client();
    if (!activeClient) return;

    const directory = options.activeWorkspaceRoot().trim();
    const tasksPath = `forge/tracks/workitem-autorun/tfs-${item.tfsId}/tasks.md`;

    try {
      const sessionApi = activeClient.session as typeof activeClient.session & {
        shellAsync?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
        shell?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
      };

      const result = await sessionApi.create({ directory: directory || undefined });
      const session = unwrap(result);
      const sessionID = session.id;

      // Try to read tasks.md
      const shellInput = {
        sessionID,
        command: `cat ${tasksPath}`,
        agent: "openwork",
        directory: directory || undefined,
      };

      const shellResult = sessionApi.shellAsync
        ? await sessionApi.shellAsync(shellInput)
        : sessionApi.shell
          ? await sessionApi.shell(shellInput)
          : null;

      if (shellResult) {
        const output = extractOutput(shellResult);
        if (output) {
          const parsed = parseTasks(output);
          setTasks(parsed);
          const nextIndex = parsed.findIndex(t => t.status === "pending" || t.status === "in-progress");
          setCurrentTaskIndex(nextIndex >= 0 ? nextIndex : 0);
        }
      }
    } catch (err) {
      console.warn("Failed to load tasks:", err);
      setTasks([]);
    }
  };

  const executeTaskStep = async (item: TaskCenterItem, taskIndex: number) => {
    const activeClient = options.client();
    if (!activeClient || executing()) return;

    const directory = options.activeWorkspaceRoot().trim();
    const tasksPath = `forge/tracks/workitem-autorun/tfs-${item.tfsId}/tasks.md`;

    setExecuting(true);
    
    try {
      const sessionApi = activeClient.session as typeof activeClient.session & {
        shellAsync?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
        shell?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
      };

      // Create session for file operations
      const result = await sessionApi.create({ directory: directory || undefined });
      const session = unwrap(result);
      const sessionID = session.id;

      // Read current tasks.md
      const readInput = {
        sessionID,
        command: `cat ${tasksPath}`,
        agent: "openwork",
        directory: directory || undefined,
      };

      const readResult = sessionApi.shellAsync
        ? await sessionApi.shellAsync(readInput)
        : sessionApi.shell
          ? await sessionApi.shell(readInput)
          : null;

      if (!readResult) {
        throw new Error("Cannot read tasks.md");
      }

      const content = extractOutput(readResult);
      if (!content) {
        throw new Error("Tasks.md is empty");
      }

      // Update task status to in-progress
      const updated = updateTaskStatus(content, taskIndex, "in-progress");
      
      // Write back
      const writeInput = {
        sessionID,
        command: `cat > ${tasksPath} << 'EOF'
${updated}
EOF`,
        agent: "openwork",
        directory: directory || undefined,
      };

      await sessionApi.shellAsync?.(writeInput) ?? sessionApi.shell?.(writeInput);

      // Update local state
      setTasks(prev => prev.map((t, i) => i === taskIndex ? { ...t, status: "in-progress" } : t));
      setCurrentTaskIndex(taskIndex);

      // Update automation state
      setAutomationState(item.tfsId, {
        status: "progress",
        stage: getStageForTask(taskIndex),
        subStage: `task-${taskIndex}`,
        sessionId: sessionID,
        blockedReason: null,
        updatedAt: Date.now(),
      });

      // Create OpenCode session for task execution
      const task = tasks()[taskIndex];
      if (task) {
        const prompt = `执行任务 ${taskIndex + 1}：${task.title}\n\n工作项: #${item.tfsId}\n\n${task.description}`;
        options.setPrompt(prompt);
        options.createSessionAndOpen();
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : "Task execution failed.";
      setError(message);
      console.error("Execute task step error:", error);
    } finally {
      setExecuting(false);
    }
  };

  const completeTaskStep = async (item: TaskCenterItem, taskIndex: number) => {
    const activeClient = options.client();
    if (!activeClient || executing()) return;

    const directory = options.activeWorkspaceRoot().trim();
    const tasksPath = `forge/tracks/workitem-autorun/tfs-${item.tfsId}/tasks.md`;

    setExecuting(true);

    try {
      const sessionApi = activeClient.session as typeof activeClient.session & {
        shellAsync?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
        shell?: (input: {
          sessionID: string;
          command: string;
          agent?: string;
          directory?: string;
        }) => Promise<unknown>;
      };

      const result = await sessionApi.create({ directory: directory || undefined });
      const session = unwrap(result);
      const sessionID = session.id;

      // Read current tasks.md
      const readInput = {
        sessionID,
        command: `cat ${tasksPath}`,
        agent: "openwork",
        directory: directory || undefined,
      };

      const readResult = sessionApi.shellAsync
        ? await sessionApi.shellAsync(readInput)
        : sessionApi.shell
          ? await sessionApi.shell(readInput)
          : null;

      if (!readResult) {
        throw new Error("Cannot read tasks.md");
      }

      const content = extractOutput(readResult);
      if (!content) {
        throw new Error("Tasks.md is empty");
      }

      // Mark current task as completed
      const updated = updateTaskStatus(content, taskIndex, "completed");

      // Write back
      const writeInput = {
        sessionID,
        command: `cat > ${tasksPath} << 'EOF'
${updated}
EOF`,
        agent: "openwork",
        directory: directory || undefined,
      };

      await sessionApi.shellAsync?.(writeInput) ?? sessionApi.shell?.(writeInput);

      // Update local state
      setTasks(prev => prev.map((t, i) => i === taskIndex ? { ...t, status: "completed" } : t));

      // Check if all tasks completed
      const allTasks = tasks().map((t, i) => i === taskIndex ? { ...t, status: "completed" as const } : t);
      const allCompleted = allTasks.every(t => t.status === "completed");

      if (allCompleted) {
        setAutomationState(item.tfsId, {
          status: "done",
          stage: "reviewing",
          subStage: null,
          sessionId: null,
          blockedReason: null,
          updatedAt: Date.now(),
        });
      } else {
        // Move to next task
        const nextIndex = allTasks.findIndex(t => t.status === "pending");
        if (nextIndex >= 0) {
          setCurrentTaskIndex(nextIndex);
        }
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : "Complete task step failed.";
      setError(message);
      console.error("Complete task step error:", error);
    } finally {
      setExecuting(false);
    }
  };

  const getStageForTask = (taskIndex: number): TaskCenterStage => {
    // Map task index to stage based on typical workflow
    if (taskIndex === 0) return "analyzing";
    if (taskIndex === 1) return "designing";
    if (taskIndex === 2) return "planning";
    return "implementing";
  };

  return {
    items,
    setItems,
    status,
    error,
    lastUpdatedAt,
    syncing,
    ui: ui ?? { search: "" },
    setUi,
    setSearch,
    filteredItems,
    itemsByStatus,
    syncTasks,
    startAutomation,
    setSyncSessionId,
    syncSessionId,
    automationState,
    setAutomationState,
    // Task execution
    selectedItem,
    selectItem,
    tasks,
    currentTaskIndex,
    executing,
    executeTaskStep,
    completeTaskStep,
    loadTasks,
  };
}
