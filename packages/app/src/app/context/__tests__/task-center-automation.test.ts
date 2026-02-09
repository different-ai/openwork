import { describe, expect, it } from "vitest";
import { mergeAutomationState, mergeTfsItemsWithAutomation } from "../task-center";
import type { TaskCenterAutomationState, TaskCenterStatus, TaskCenterItem } from "../../types";

describe("mergeAutomationState", () => {
  it("overrides TFS status with automation state", () => {
    const tfsItems = [{ tfsId: 1, status: "todo" as TaskCenterStatus }];
    const automation = new Map<number, TaskCenterAutomationState>([
      [1, { status: "progress", stage: "analyzing", updatedAt: Date.now() }]
    ]);
    
    const merged = mergeAutomationState(tfsItems, automation);
    
    expect(merged.get(1)?.status).toBe("progress");
    expect(merged.get(1)?.stage).toBe("analyzing");
  });

  it("creates new automation state for new TFS items", () => {
    const tfsItems = [{ tfsId: 1, status: "todo" as TaskCenterStatus }];
    const automation = new Map<number, TaskCenterAutomationState>();
    
    const merged = mergeAutomationState(tfsItems, automation);
    
    expect(merged.get(1)?.status).toBe("todo");
    expect(merged.get(1)?.stage).toBe("idle");
    expect(merged.get(1)?.updatedAt).toBeGreaterThan(0);
  });

  it("preserves existing automation fields when merging", () => {
    const now = Date.now();
    const tfsItems = [{ tfsId: 1, status: "todo" as TaskCenterStatus }];
    const automation = new Map<number, TaskCenterAutomationState>([
      [1, { 
        status: "progress", 
        stage: "implementing", 
        subStage: "workspace-prep",
        sessionId: "session-123",
        blockedReason: null,
        updatedAt: now 
      }]
    ]);
    
    const merged = mergeAutomationState(tfsItems, automation);
    
    expect(merged.get(1)?.stage).toBe("implementing");
    expect(merged.get(1)?.subStage).toBe("workspace-prep");
    expect(merged.get(1)?.sessionId).toBe("session-123");
  });

  it("updates status when TFS status differs from automation", () => {
    const tfsItems = [{ tfsId: 1, status: "done" as TaskCenterStatus }];
    const automation = new Map<number, TaskCenterAutomationState>([
      [1, { status: "progress", stage: "analyzing", updatedAt: Date.now() }]
    ]);
    
    const merged = mergeAutomationState(tfsItems, automation);
    
    expect(merged.get(1)?.status).toBe("done");
    expect(merged.get(1)?.stage).toBe("analyzing"); // stage preserved
  });
});

describe("mergeTfsItemsWithAutomation", () => {
  it("keeps automation items not returned by TFS query", () => {
    const tfsItems: TaskCenterItem[] = [];
    const automation = new Map<number, TaskCenterAutomationState>([
      [9, { status: "done", stage: "reviewing", updatedAt: Date.now() }]
    ]);
    
    const merged = mergeTfsItemsWithAutomation(tfsItems, automation);
    
    expect(merged.length).toBe(1);
    expect(merged[0].tfsId).toBe(9);
    expect(merged[0].status).toBe("done");
    expect(merged[0].stage).toBe("reviewing");
  });

  it("merges TFS items with automation state", () => {
    const tfsItems: TaskCenterItem[] = [
      { 
        id: "tfs-1", 
        tfsId: 1, 
        title: "Test", 
        status: "todo",
        stage: "idle"
      }
    ];
    const automation = new Map<number, TaskCenterAutomationState>([
      [1, { status: "progress", stage: "analyzing", updatedAt: Date.now() }]
    ]);
    
    const merged = mergeTfsItemsWithAutomation(tfsItems, automation);
    
    expect(merged.length).toBe(1);
    expect(merged[0].status).toBe("progress");
    expect(merged[0].stage).toBe("analyzing");
  });

  it("combines TFS and automation items correctly", () => {
    const tfsItems: TaskCenterItem[] = [
      { id: "tfs-1", tfsId: 1, title: "Item 1", status: "todo", stage: "idle" }
    ];
    const automation = new Map<number, TaskCenterAutomationState>([
      [1, { status: "progress", stage: "analyzing", updatedAt: Date.now() }],
      [2, { status: "done", stage: "reviewing", updatedAt: Date.now() }]
    ]);
    
    const merged = mergeTfsItemsWithAutomation(tfsItems, automation);
    
    expect(merged.length).toBe(2);
    // Item 1 should be merged with automation
    const item1 = merged.find(i => i.tfsId === 1);
    expect(item1?.status).toBe("progress");
    // Item 2 should be preserved from automation even though not in TFS
    const item2 = merged.find(i => i.tfsId === 2);
    expect(item2?.status).toBe("done");
  });
});
