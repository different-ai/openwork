# Tasks

> **For Claude:** REQUIRED SUB-SKILL: Use forge:executing-plans to implement this plan task-by-task.

**Change:** workitem-autorun

**Goal:** Automate Task Center ToDo("已分析") work items through Forge/openspec workflow with progress sub-stages. TFS state is updated twice: first to "活动" when starting automation, then to "已解决" after archive.

**Architecture:** Add a persisted automation state map, merge it with TFS sync results, show stage/subStage in UI, and drive Forge artifacts via a new orchestrator skill. TFS state updates: "已分析" → "活动" (on start) → "已解决" (on archive).

**Tech Stack:** SolidJS (Task Center UI/store), OpenCode skills, Node CLI tools, TFS integration.

---

### Task 1: 添加自动化状态模型 + 持久化 ✅ 已完成

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/context/task-center.ts`
- Create: `packages/app/src/app/context/__tests__/task-center-automation.test.ts`
- Create: `packages/app/vitest.config.ts`
- Modify: `packages/app/package.json`

**Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { mergeAutomationState } from "../task-center";

it("overrides TFS status with automation state", () => {
  const tfsItems = [{ tfsId: 1, status: "todo" }];
  const automation = { 1: { status: "progress", stage: "analyzing" } };
  const merged = mergeAutomationState(tfsItems, automation);
  expect(merged[0].status).toBe("progress");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: FAIL because `mergeAutomationState` does not exist.

**Step 3: Write minimal implementation**

```ts
export type TaskCenterAutomationState = {
  status: TaskCenterStatus;
  stage: TaskCenterStage;
  subStage?: string | null;
  sessionId?: string | null;
  blockedReason?: string | null;
  updatedAt: number;
};

export function mergeAutomationState(
  tfsItems: Array<{ tfsId: number; status: TaskCenterStatus }>,
  automation: Map<number, TaskCenterAutomationState>
): Map<number, TaskCenterAutomationState> {
  const result = new Map<number, TaskCenterAutomationState>();

  for (const item of tfsItems) {
    const existing = automation.get(item.tfsId);
    const newItem = { status: item.status, stage: "idle", updatedAt: Date.now() };

    if (existing) {
      // Keep stage, subStage, sessionId, blockedReason from existing automation
      newItem.stage = existing.stage;
      newItem.subStage = existing.subStage;
      newItem.sessionId = existing.sessionId;
      newItem.blockedReason = existing.blockedReason;

      // Update status: only if TFS state changed and matches automation status
      if (existing.status !== item.status) {
        newItem.status = item.status;
      }
    }

    result.set(item.tfsId, newItem);
  }

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/package.json packages/app/src/app/types.ts packages/app/src/app/context/task-center.ts packages/app/src/app/context/__tests__/task-center-automation.test.ts
git commit -m "feat: add task center automation state model"
```

---

### Task 2: 合并自动化状态与 TFS 同步结果

**Files:**
- Modify: `packages/app/src/app/context/task-center.ts`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write failing test**

```ts
it("keeps automation items not returned by TFS query", () => {
  const tfsItems = [];
  const automation = { 9: { status: "done", stage: "reviewing" } };
  const merged = mergeAutomationState(tfsItems, automation);

  expect(merged.size).toBe(1);
  expect(merged.get(9)).toEqual({ tfsId: 9, status: "done", stage: "reviewing" });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 3: Write minimal implementation**

```ts
export function syncTasks = async (syncOptions?: { force?: boolean }) => {
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
      : sessionApi.shell(shellInput);

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

    const nextItems = parseWorkItems(trimmed).map((item) => ({
      ...item,
      stage: "idle",
    }));
    setItems(nextItems);
    setLastUpdatedAt(Date.now());
    setStatus("idle");
    setSyncSessionId(null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task sync failed.";
    setError(message);
    setStatus("error");
  }
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/task-center.ts
git commit -m "feat: merge automation state into task sync"
```

---

### Task 3: 强制 ToDo = "已分析"

**Files:**
- Modify: `.opencode/skills/tfs2018-integration/tools/task-center-integration.mjs`
- Modify: `packages/app/src/app/context/task-center.ts`

**Step 1: Write failing test**

```ts
it("maps only 已分析 to todo", () => {
  expect(mapStateToStatus("已分析")).toBe("todo");
  expect(mapStateToStatus("已建议")).not.toBe("todo");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: FAIL.

**Step 3: Write minimal implementation**

```javascript
// Update default states in task-center-integration.mjs

// Original:
// states = ['已建议', '活动', '已解决', '已关闭'];

// Updated:
const states = ['已分析', '活动', '已解决', '已关闭'];
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add .opencode/skills/tfs2018-integration/tools/task-center-integration.mjs packages/app/src/app/context/task-center.ts
git commit -m "feat: restrict todo to 已分析"
```

---

### Task 4: UI 显示阶段 + subStage

**Files:**
- Modify: `packages/app/src/app/pages/task-center.tsx`

**Step 1: Write failing test**

```tsx
it("renders stage badge when stage is present", () => {
  const { container } = render(<TaskCenterView itemsByStatus={{
    todo: [
      { id: "tfs-1", status: "todo", stage: "analyzing", subStage: "workspace-prep" }
    ],
    progress: [],
    }} />);

  // Expect to find "分析" text in as a todo card
  expect(container.textContent).toContain("分析");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: FAIL.

**Step 3: Write minimal implementation**

```tsx
// Show stage badge when stage is present
<Show when={item.stage}>
  <span class="...">{stageLabel(item.stage, item.subStage)}</span>
</Show>
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/task-center.tsx
git commit -m "feat: render task center stages"
```

---

### Task 5: 添加"生成计划"和"查看计划"按钮（问题3）

**Files:**
- Modify: `packages/app/src/app/pages/task-center.tsx`
- Modify: `packages/app/src/app/context/task-center.ts`

**Step 1: Write failing test**

```tsx
it("shows '生成计划' button for todo items", () => {
  const { getByText } = render(<TaskCard item={{
    id: "tfs-1",
    status: "todo",
    title: "测试工作项",
    stage: null,
    subStage: null
  }} />);

  expect(getByText("生成计划")).toBeInTheDocument();
});

it("shows '查看计划' button for progress items", () => {
  const { getByText } = render(<TaskCard item={{
    id: "tfs-1",
    status: "progress",
    title: "测试工作项",
    stage: "analyzing",
    subStage: null
  }} />);

  expect(getByText("查看计划")).toBeInTheDocument();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: FAIL.

**Step 3: Write minimal implementation**

```tsx
// TaskCard component
const TaskCard = (props: { item: TaskCenterItem }) => {
  const getButtonConfig = (item: TaskCenterItem) => {
    switch (item.status) {
      case "todo":
        return { text: "生成计划", action: () => generatePlan(item) };
      case "progress":
      case "done":
      case "blocked":
        return { text: "查看计划", action: () => viewPlan(item) };
      case "archived":
        return { text: "查看归档", action: () => viewArchive(item) };
      default:
        return null;
    }
  };

  const config = getButtonConfig(props.item);

  return (
    <div class="task-card">
      <h3>{props.item.title}</h3>
      <Show when={props.item.stage}>
        <span class="stage-badge">{stageLabel(props.item.stage, props.item.subStage)}</span>
      </Show>
      <Show when={config}>
        <button onClick={config.action}>{config.text}</button>
      </Show>
    </div>
  );
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/task-center.tsx packages/app/src/app/context/task-center.ts
git commit -m "feat: add generate/view plan buttons based on status"
```

---

### Task 6: 生成计划时更新 TFS 状态为"活动"（重要变更）

**Files:**
- Modify: `packages/app/src/app/context/task-center.ts`
- Modify: `.opencode/skills/tfs2018-integration/tools/task-center-integration.mjs`

**Step 1: Write failing test**

```ts
it("updates TFS state to '活动' when generating plan", async () => {
  const mockUpdateWorkItemState = vi.fn((id, state) => Promise.resolve());

  // Mock TFS client
  const tfsClient = {
    updateWorkItemState: mockUpdateWorkItemState,
  };

  // Call generatePlan
  await generatePlan({ tfsId: 1, title: "测试工作项" }, tfsClient);

  // Verify TFS was updated to "活动"
  expect(mockUpdateWorkItemState).toHaveBeenCalledWith(1, "活动");
});

it("does not create plan files if TFS update fails", async () => {
  const mockUpdateWorkItemState = vi.fn((id, state) => 
    Promise.reject(new Error("TFS update failed"))
  );

  const tfsClient = {
    updateWorkItemState: mockUpdateWorkItemState,
  };

  // Call generatePlan
  await expect(generatePlan({ tfsId: 1, title: "测试工作项" }, tfsClient))
    .rejects.toThrow("TFS update failed");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// In task-center.ts
const generatePlan = async (item: TaskCenterItem, tfsClient: TfsClient) => {
  try {
    // Step 1: Update TFS state to "活动"
    await tfsClient.updateWorkItemState(item.tfsId, "活动");

    // Step 2: Create automation state
    setAutomationState(item.tfsId, {
      status: "progress",
      stage: "planning",
      subStage: null,
      sessionId: null,
      blockedReason: null,
      updatedAt: Date.now(),
    });

    // Step 3: Create plan via OpenCode session
    const prompt = `为 TFS 工作项 #${item.tfsId} 生成 Forge 计划:\n标题: ${item.title}`;
    options.setPrompt(prompt);
    await options.createSessionAndOpen();

  } catch (error) {
    console.error("Failed to start automation:", error);
    throw error;
  }
};
```

```javascript
// In task-center-integration.mjs - add updateWorkItemState method
export async function updateWorkItemState(id, state, comment = "") {
  // Validate state
  const validStates = ["活动", "已解决"];
  if (!validStates.includes(state)) {
    throw new Error(`Invalid state: ${state}. Allowed: ${validStates.join(", ")}`);
  }

  const tfsApi = await this.getWorkItemApi();
  await tfsApi.updateWorkItemState(id, state, comment || `更新状态为${state}`);
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/task-center.ts .opencode/skills/tfs2018-integration/tools/task-center-integration.mjs
git commit -m "feat: update TFS state to '活动' when starting automation"
```

---

### Task 7: 实现 tasks.md 解析器（问题4逐步执行基础）

**Files:**
- Create: `packages/app/src/app/lib/tasks-parser.ts`
- Create: `packages/app/src/app/lib/__tests__/tasks-parser.test.ts`

**Step 1: Write failing test**

```ts
it("parses tasks with status from markdown", () => {
  const markdown = `
### Task 1: 分析需求

**状态**: ⏳ 待执行

**描述**: 分析工作项需求

### Task 2: 设计方案

**状态**: ✅ 已完成
`;

  const tasks = parseTasks(markdown);
  expect(tasks[0].status).toBe("pending");
  expect(tasks[1].status).toBe("completed");
});

it("updates task status in markdown", () => {
  const markdown = `### Task 1\n\n**状态**: ⏳ 待执行`;
  const updated = updateTaskStatus(markdown, 0, "in-progress");
  expect(updated).toContain("🔄 执行中");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
export interface ParsedTask {
  index: number;
  title: string;
  status: "pending" | "in-progress" | "completed" | "failed";
  description: string;
}

export function parseTasks(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const lines = markdown.split("\n");
  let currentTask: Partial<ParsedTask> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match Task header: ### Task X: Title
    const taskMatch = line.match(/^### Task (\d+):\s*(.+)$/);
    if (taskMatch) {
      if (currentTask) {
        tasks.push(currentTask as ParsedTask);
      }
      currentTask = {
        index: parseInt(taskMatch[1]) - 1,
        title: taskMatch[2],
        status: "pending",
        description: "",
      };
    }

    // Match status line
    const statusMatch = line.match(/\*\*状态\*\*:\s*([⏳🔄✅❌])\s*(.+)/);
    if (statusMatch && currentTask) {
      const statusMap: Record<string, ParsedTask["status"]> = {
        "⏳": "pending",
        "🔄": "in-progress",
        "✅": "completed",
        "❌": "failed",
      };
      currentTask.status = statusMap[statusMatch[1]] || "pending";
    }

    // Accumulate description
    if (currentTask && line.startsWith("**描述**")) {
      currentTask.description = line.replace("**描述**:", "").trim();
    }
  }

  if (currentTask) {
    tasks.push(currentTask as ParsedTask);
  }

  return tasks;
}

export function updateTaskStatus(
  markdown: string,
  taskIndex: number,
  status: ParsedTask["status"]
): string {
  const statusMap: Record<ParsedTask["status"], string> = {
    pending: "⏳ 待执行",
    "in-progress": "🔄 执行中",
    completed: "✅ 已完成",
    failed: "❌ 失败",
  };

  const lines = markdown.split("\n");
  let currentTaskIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const taskMatch = lines[i].match(/^### Task (\d+):/);
    if (taskMatch) {
      currentTaskIndex = parseInt(taskMatch[1]) - 1;
    }

    if (currentTaskIndex === taskIndex && lines[i].includes("**状态**")) {
      lines[i] = `**状态**: ${statusMap[status]}`;
      break;
    }
  }

  return lines.join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/tasks-parser.ts packages/app/src/app/lib/__tests__/tasks-parser.test.ts
git commit -m "feat: add tasks.md parser for step-by-step execution"
```

---

### Task 8: 实现逐步执行流程（问题4）

**Files:**
- Modify: `.opencode/skills/forge-orchestrator/tools/forge-orchestrator.mjs`
- Modify: `packages/app/src/app/context/task-center.ts`
- Modify: `packages/app/src/app/pages/task-center.tsx`

**Step 1: Write failing test**

```tsx
it("executes task step by step", async () => {
  const mockUpdateTaskStatus = vi.fn();

  // Start first task
  await executeTaskStep({ tfsId: 1, taskIndex: 0 });

  // Should update task status to in-progress
  expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
    expect.any(String),
    0,
    "in-progress"
  );
});

it("shows '开始执行' button for pending tasks", () => {
  const { getByText } = render(<TaskExecutionPanel
    tasks={[{ index: 0, title: "Task 1", status: "pending", description: "" }]}
    currentTaskIndex={0}
  />);

  expect(getByText("开始执行")).toBeInTheDocument();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
// In task-center.ts
const executeTaskStep = async (item: TaskCenterItem, taskIndex: number) => {
  const tasksPath = `forge/tracks/workitem-autorun/tfs-${item.tfsId}/tasks.md`;

  // Read current tasks.md
  const content = await readFile(tasksPath);

  // Update current task to in-progress
  const updated = updateTaskStatus(content, taskIndex, "in-progress");
  await writeFile(tasksPath, updated);

  // Update automation state
  setAutomationState(item.tfsId, {
    ...automationState.get(item.tfsId),
    status: "progress",
    stage: getStageForTask(taskIndex),
    updatedAt: Date.now(),
  });

  // Execute the task via OpenCode session
  const prompt = `执行任务 ${taskIndex + 1}：${getTaskTitle(content, taskIndex)}\n\n工作项: #${item.tfsId}`;
  options.setPrompt(prompt);
  await options.createSessionAndOpen();
};

const completeTaskStep = async (item: TaskCenterItem, taskIndex: number) => {
  const tasksPath = `forge/tracks/workitem-autorun/tfs-${item.tfsId}/tasks.md`;
  const content = await readFile(tasksPath);

  // Mark current task as completed
  const updated = updateTaskStatus(content, taskIndex, "completed");
  await writeFile(tasksPath, updated);

  // Check if all tasks completed
  const tasks = parseTasks(updated);
  const allCompleted = tasks.every(t => t.status === "completed");

  if (allCompleted) {
    setAutomationState(item.tfsId, {
      ...automationState.get(item.tfsId),
      status: "done",
      stage: "reviewing",
      updatedAt: Date.now(),
    });
  }
};
```

**UI Component:**

```tsx
// TaskExecutionPanel component
const TaskExecutionPanel = (props: {
  tasks: ParsedTask[];
  currentTaskIndex: number;
  onExecute: (index: number) => void;
}) => {
  return (
    <div class="task-execution-panel">
      <h4>执行计划</h4>
      <For each={props.tasks}>
        {(task, index) => (
          <div class={"task-item " + task.status}>
            <span class="task-status">
              {task.status === "pending" && "⏳"}
              {task.status === "in-progress" && "🔄"}
              {task.status === "completed" && "✅"}
              {task.status === "failed" && "❌"}
            </span>
            <span class="task-title">{task.title}</span>
            <Show when={task.status === "pending" && index() === props.currentTaskIndex}>
              <button onClick={() => props.onExecute(index())}>
                开始执行
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/task-center.ts packages/app/src/app/pages/task-center.tsx
git commit -m "feat: implement step-by-step task execution"
```

---

### Task 9: 添加 Forge 编排器技能

**Files:**
- Create: `.opencode/skills/forge-orchestrator/SKILL.md`
- Create: `.opencode/skills/forge-orchestrator/tools/forge-orchestrator.mjs`
- Modify: `packages/app/src/app/context/task-center.ts`

**Step 1: Write failing test**

```ts
it("sets progress + analyzing on startAutomation", () => {
  // Mock TFS client and updateWorkItemState
  const mockUpdateWorkItemState = vi.fn((id, state) => Promise.resolve());
  const mockTfsClient = {
    updateWorkItemState: mockUpdateWorkItemState,
  } as any;

  const { setAutomationState } = vi.hoisted<{ setAutomationState: any }>();

  // Call startAutomation - should NOT open session
  startAutomation({ tfsId: 1, title: "Test Item" });

  // Verify automation state was set
  expect(setAutomationState).toHaveBeenCalledWith(1, {
    status: "progress",
    stage: "analyzing",
    subStage: undefined,
    sessionId: undefined,  // no session should be created
    updatedAt: expect.any(Number),
    blockedReason: undefined,
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: FAIL.

**Step 3: Write minimal implementation**

```ts
import type { TaskCenterItem } from "../types";

const startAutomation = (item: TaskCenterItem) => {
  const prompt = `使用 forge-orchestrator 处理 TFS 工作项 #${item.tfsId}`;
  options.setPrompt(prompt);
  options.createSessionAndOpen();
};

export { startAutomation };
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/task-center.ts
git commit -m "feat: add forge orchestrator automation"
```

---

### Task 10: 归档完成后更新 TFS 为"已解决"

**Files:**
- Create: `.opencode/skills/forge-orchestrator/tools/forge-orchestrator.mjs`
- Modify: `.opencode/skills/tfs2018-integration/tools/task-center-integration.mjs`

**Step 1: Write failing test**

```ts
it("updates TFS to 已解决 only after archive", () => {
  // Mock updateWorkItemState
  const mockUpdateWorkItemState = vi.fn((id, state) => Promise.resolve());

  // Call updateWorkItemState
  await updateWorkItemState(1, "已解决");

  // Verify it was called with correct parameters
  expect(mockUpdateWorkItemState).toHaveBeenCalledWith(1, "已解决");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 3: Write minimal implementation**

```javascript
// Add updateWorkItemState to TFS client
export async function updateWorkItemState(id, state, comment) {
  // Validate state
  if (state !== "已解决") {
    throw new Error(`Only '已解决' state is allowed for updateWorkItemState`);
  }

  // This would be called by orchestrator on archive completion
  const tfsApi = await this.getWorkItemApi();
  await tfsApi.updateWorkItemState(id, state, comment);
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C packages/app test`
Expected: PASS.

**Step 5: Commit**

```bash
git add .opencode/skills/forge-orchestrator/tools/forge-orchestrator.mjs .opencode/skills/tfs2018-integration/tools/task-center-integration.mjs
git commit -m "feat: add updateWorkItemState for TFS archive completion"
```