import { describe, expect, it } from "vitest";
import { mergeAutomationState } from "../task-center";
import type { TaskCenterAutomationState, TaskCenterStatus } from "../../types";

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
