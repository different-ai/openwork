/**
 * Tasks.md Parser - 解析 Forge 计划的 tasks.md 文件
 * 
 * 用于逐步执行任务计划
 */

export interface ParsedTask {
  index: number;
  title: string;
  status: "pending" | "in-progress" | "completed" | "failed";
  description: string;
}

const statusMap: Record<string, ParsedTask["status"]> = {
  "⏳": "pending",
  "🔄": "in-progress",
  "✅": "completed",
  "❌": "failed",
};

const reverseStatusMap: Record<ParsedTask["status"], string> = {
  pending: "⏳ 待执行",
  "in-progress": "🔄 执行中",
  completed: "✅ 已完成",
  failed: "❌ 失败",
};

/**
 * 从 markdown 内容解析任务列表
 */
export function parseTasks(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const lines = markdown.split("\n");
  let currentTask: Partial<ParsedTask> | null = null;
  let descriptionLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match Task header: ### Task X: Title
    const taskMatch = line.match(/^### Task (\d+):\s*(.+)$/);
    if (taskMatch) {
      // Save previous task if exists
      if (currentTask) {
        currentTask.description = descriptionLines.join("\n").trim();
        tasks.push(currentTask as ParsedTask);
      }

      // Start new task
      currentTask = {
        index: parseInt(taskMatch[1]) - 1,
        title: taskMatch[2],
        status: "pending",
        description: "",
      };
      descriptionLines = [];
      continue;
    }

    // Match status line: **状态**: ⏳ 待执行
    const statusMatch = line.match(/\*\*状态\*\*:\s*([⏳🔄✅❌])\s*(.+)/);
    if (statusMatch && currentTask) {
      currentTask.status = statusMap[statusMatch[1]] || "pending";
    }

    // Collect description lines (skip empty lines and metadata)
    if (currentTask && line.trim() && !line.match(/^\*\*(状态|文件|步骤)\*\*:/)) {
      descriptionLines.push(line);
    }
  }

  // Save last task
  if (currentTask) {
    currentTask.description = descriptionLines.join("\n").trim();
    tasks.push(currentTask as ParsedTask);
  }

  return tasks;
}

/**
 * 更新任务状态并返回更新后的 markdown
 */
export function updateTaskStatus(
  markdown: string,
  taskIndex: number,
  status: ParsedTask["status"]
): string {
  const lines = markdown.split("\n");
  let currentTaskIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const taskMatch = lines[i].match(/^### Task (\d+):/);
    if (taskMatch) {
      currentTaskIndex = parseInt(taskMatch[1]) - 1;
    }

    if (currentTaskIndex === taskIndex && lines[i].includes("**状态**")) {
      lines[i] = `**状态**: ${reverseStatusMap[status]}`;
      break;
    }
  }

  return lines.join("\n");
}

/**
 * 获取下一个待执行的任务索引
 */
export function getNextPendingTaskIndex(tasks: ParsedTask[]): number {
  const pending = tasks.find((t) => t.status === "pending" || t.status === "in-progress");
  return pending ? pending.index : -1;
}

/**
 * 检查是否所有任务都已完成
 */
export function areAllTasksCompleted(tasks: ParsedTask[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.status === "completed");
}
