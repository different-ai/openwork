# Design: workitem-autorun

## Overview
This change aligns Task Center with a Forge/openspec workflow for work items in TFS state "已分析". It introduces a stable column meaning (ToDo/Progress/Done/Blocked/Archived) and adds sub-stage visibility during implementation. TFS state is only updated to "已解决" after archive completes.

## Current state
- Task Center maps TFS state directly to columns.
- `TaskCenterStage` exists but is not rendered or persisted.
- Sync replaces items on each refresh, which drops any local progress.
- `startAutomation` only opens a session with a generic prompt.

## Proposed architecture
1. **Forge orchestrator skill**
   - New skill (e.g. `.opencode/skills/forge-orchestrator`) drives a staged flow: analyze → design → plan → implement → review → archive.
   - It reads TFS work item details and writes Forge artifacts under `forge/tracks/workitem-autorun/`.
   - It emits structured progress updates (stage/subStage) that Task Center can consume.

2. **Local automation state store**
   - Persist a per-item automation state (status/stage/subStage/sessionId/updatedAt).
   - Sync merges TFS items with local automation state so Progress/Done/Blocked/Archived remain visible even if TFS query returns only "已分析" items.

3. **Status semantics**
   - **ToDo**: only "已分析" and not started.
   - **Progress**: automation active; stage shown.
   - **Done**: plan executed, waiting archive.
   - **Blocked**: workflow interrupted; show last stage/subStage.
   - **Archived**: archive complete; update TFS to "已解决".

## Data model changes

### TaskCenterAutomationState (new)
```
{
  tfsId: number
  status: "todo" | "progress" | "done" | "failed" | "archived"
  stage: "idle" | "analyzing" | "designing" | "planning" | "implementing" | "reviewing" | "archiving"
  subStage?: "workspace-prep" | "plan-exec" | "tests" | "fixes" | "ready-review" | null
  sessionId?: string | null
  blockedReason?: string | null
  updatedAt: number
}
```

### TaskCenterItem (extended)
- Add `subStage?: string | null` and merge automation state into `status` and `stage` at runtime.

## Stage and subStage mapping
- Stage labels (UI):
  - analyzing=分析, designing=设计, planning=计划, implementing=实现, reviewing=评审, archiving=归档
- Implementing subStage labels:
  - workspace-prep=环境初始化
  - plan-exec=执行计划
  - tests=运行测试
  - fixes=修复问题
  - ready-review=待评审

## Sync merge behavior
1. Run TFS query for "已分析" only.
2. Build a map of TFS items by `tfsId`.
3. Load persisted automation state by `tfsId`.
4. Merge rules:
   - If automation state exists, its `status/stage/subStage` override the TFS-derived status.
   - If an automation item is not returned by TFS query, keep it in the list.
   - If an item is archived, keep it in Archived column even if not in TFS query.

## Orchestrator responsibilities
- Create or update `intent.md`, `design.md`, `tasks.md` in the track.
- Update automation state per phase (stage/subStage).
- On archive completion, update TFS state to "已解决".
- On failure, set status=failed and record `blockedReason`.

## UI changes
- Show stage badge under each card in Progress/Blocked/Done/Archived.
- Show subStage only when stage=implementing.
- Keep the existing columns and tones; no new columns.

## Error handling
- If a phase fails, mark the item as Blocked with last stage/subStage and error message.
- Do not update TFS state on failures.

## Verification
- Typecheck for UI changes.
- Unit tests for merge logic and status mapping if test harness is added.
