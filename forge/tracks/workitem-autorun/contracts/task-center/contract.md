# Task Center Automation Contract (workitem-autorun)

## Purpose
Define Task Center automation behavior for "已分析" work items and map Forge/openspec workflow progress into Task Center statuses and sub-stages.

## Requirements

### REQ-1: ToDo scope
- Task Center ToDo lists only work items whose TFS state is exactly "已分析".

### REQ-2: Progress with sub-stage
- Progress represents the active automation flow.
- Use `TaskCenterStage` for the main phase and `subStage` for implementing details.
- Implementing subStage values include: `workspace-prep`, `plan-exec`, `tests`, `fixes`, `ready-review`.

### REQ-3: Done meaning
- Done indicates the implementation plan is complete and waiting for archive.
- Done does not update TFS state.

### REQ-4: Blocked meaning
- Blocked represents an interrupted or divergent workflow.
- Blocked retains the last `stage` and `subStage` for diagnosis.

### REQ-5: Archived meaning
- Archived means documentation is archived and code changes are finalized.
- Only after archive completes, update TFS state to "已解决".

### REQ-6: Forge artifacts
- Generate artifacts under `forge/tracks/workitem-autorun/`:
  - `intent.md`
  - `design.md`
  - `tasks.md`

### REQ-7: Sync merge
- Task Center sync must preserve local automation states even when TFS query returns only "已分析" items.
