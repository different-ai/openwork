import { describe, expect, it } from "vitest";
import { parseTasks, updateTaskStatus, getNextPendingTaskIndex, areAllTasksCompleted, type ParsedTask } from "../tasks-parser";

describe("tasks-parser", () => {
  describe("parseTasks", () => {
    it("parses tasks with status from markdown", () => {
      const markdown = `
### Task 1: 分析需求

**状态**: ⏳ 待执行

**描述**: 分析工作项需求

### Task 2: 设计方案

**状态**: ✅ 已完成
`;

      const tasks = parseTasks(markdown);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].index).toBe(0);
      expect(tasks[0].title).toBe("分析需求");
      expect(tasks[0].status).toBe("pending");
      expect(tasks[1].index).toBe(1);
      expect(tasks[1].title).toBe("设计方案");
      expect(tasks[1].status).toBe("completed");
    });

    it("parses all status types", () => {
      const markdown = `
### Task 1: 待执行的任务

**状态**: ⏳ 待执行

### Task 2: 执行中的任务

**状态**: 🔄 执行中

### Task 3: 已完成的任务

**状态**: ✅ 已完成

### Task 4: 失败的任务

**状态**: ❌ 失败
`;

      const tasks = parseTasks(markdown);
      expect(tasks[0].status).toBe("pending");
      expect(tasks[1].status).toBe("in-progress");
      expect(tasks[2].status).toBe("completed");
      expect(tasks[3].status).toBe("failed");
    });

    it("extracts description", () => {
      const markdown = `
### Task 1: 分析需求

**状态**: ⏳ 待执行

**描述**: 这是任务描述
多行内容
`;

      const tasks = parseTasks(markdown);
      expect(tasks[0].description).toContain("这是任务描述");
    });
  });

  describe("updateTaskStatus", () => {
    it("updates task status in markdown", () => {
      const markdown = `### Task 1\n\n**状态**: ⏳ 待执行`;
      const updated = updateTaskStatus(markdown, 0, "in-progress");
      expect(updated).toContain("🔄 执行中");
    });

    it("updates to completed status", () => {
      const markdown = `### Task 1\n\n**状态**: 🔄 执行中`;
      const updated = updateTaskStatus(markdown, 0, "completed");
      expect(updated).toContain("✅ 已完成");
    });
  });

  describe("getNextPendingTaskIndex", () => {
    it("returns first pending task index", () => {
      const tasks: ParsedTask[] = [
        { index: 0, title: "Task 1", status: "completed", description: "" },
        { index: 1, title: "Task 2", status: "pending", description: "" },
        { index: 2, title: "Task 3", status: "pending", description: "" },
      ];
      expect(getNextPendingTaskIndex(tasks)).toBe(1);
    });

    it("returns -1 when no pending tasks", () => {
      const tasks: ParsedTask[] = [
        { index: 0, title: "Task 1", status: "completed", description: "" },
      ];
      expect(getNextPendingTaskIndex(tasks)).toBe(-1);
    });

    it("returns in-progress task", () => {
      const tasks: ParsedTask[] = [
        { index: 0, title: "Task 1", status: "completed", description: "" },
        { index: 1, title: "Task 2", status: "in-progress", description: "" },
      ];
      expect(getNextPendingTaskIndex(tasks)).toBe(1);
    });
  });

  describe("areAllTasksCompleted", () => {
    it("returns true when all tasks completed", () => {
      const tasks: ParsedTask[] = [
        { index: 0, title: "Task 1", status: "completed", description: "" },
        { index: 1, title: "Task 2", status: "completed", description: "" },
      ];
      expect(areAllTasksCompleted(tasks)).toBe(true);
    });

    it("returns false when some tasks pending", () => {
      const tasks: ParsedTask[] = [
        { index: 0, title: "Task 1", status: "completed", description: "" },
        { index: 1, title: "Task 2", status: "pending", description: "" },
      ];
      expect(areAllTasksCompleted(tasks)).toBe(false);
    });

    it("returns false for empty tasks", () => {
      expect(areAllTasksCompleted([])).toBe(false);
    });
  });
});
