import { createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import type { Client, TaskCenterItem, TaskCenterStatus, TaskCenterStage, TaskCenterAutomationState } from "../types";
import { Persist, persisted } from "../utils/persist";
import { unwrap } from "../lib/opencode";

// Merge automation state with TFS items
// Merge TFS items with automation state - preserves automation items not in TFS query
export function mergeTfsItemsWithAutomation(
  tfsItems: TaskCenterItem[],
  automation: Map<number, TaskCenterAutomationState>
): TaskCenterItem[] {
  const result: TaskCenterItem[] = [];
  const processedTfsIds = new Set<number>();

  // First, process all TFS items and merge with automation
  for (const item of tfsItems) {
    const autoState = automation.get(item.tfsId);
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
  for (const [tfsId, autoState] of automation.entries()) {
    if (!processedTfsIds.has(tfsId)) {
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
  automation: Map<number, TaskCenterAutomationState>
): Map<number, TaskCenterAutomationState> {
  const result = new Map<number, TaskCenterAutomationState>();

  for (const item of tfsItems) {
    const existing = automation.get(item.tfsId);
    
    if (existing) {
      // Check if TFS is in a final state (done/archived) - use TFS state
      const isTfsFinal = item.status === "done" || item.status === "archived";
      
      result.set(item.tfsId, {
        ...existing,
        status: isTfsFinal ? item.status : existing.status,
        updatedAt: Date.now()
      });
    } else {
      // No automation state: create from TFS item
      result.set(item.tfsId, {
        status: item.status,
        stage: "idle" as TaskCenterStage,
        updatedAt: Date.now()
      });
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

  // Automation state store - persists automation progress
  const [automationState, setAutomationState] = (() => {
    const initialState = new Map<number, TaskCenterAutomationState>();
    const store = createStore<Map<number, TaskCenterAutomationState>>(initialState);
    return persisted(Persist.global("task-center.automation"), store);
  })();

  const [ui, setUi] = (() => {
    const store = createStore<TaskCenterUiState>({
      search: "",
    });
    return persisted(Persist.global("task-center.ui"), store);
  })();

  const filteredItems = createMemo(() => {
    const uiState = ui[0];
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

  const setSearch = (value: string) => setUi[1]("search", value);

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
      const mergedItems = mergeTfsItemsWithAutomation(tfsItems, automationState[0] ?? new Map());
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

  const startAutomation = (item: TaskCenterItem) => {
    const prompt = `使用 task-automation skill 完整处理 TFS 工作项 #${item.tfsId}。`;
    options.setPrompt(prompt);
    options.createSessionAndOpen();
  };

  return {
    items,
    setItems,
    status,
    error,
    lastUpdatedAt,
    syncing,
    ui: ui[0] ?? { search: "" },
    setUi: ui[1],
    setSearch,
    filteredItems,
    itemsByStatus,
    syncTasks,
    startAutomation,
    setSyncSessionId,
    syncSessionId,
    automationState: automationState[0] ?? new Map(),
    setAutomationState: automationState[1],
  };
}
