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

### REQ-3: Progress TFS state update (重要变更)
- When user clicks "生成计划" button, **first update TFS state from "已分析" to "活动"**.
- Only after TFS update succeeds, create Forge artifacts (intent.md, design.md, tasks.md).
- If TFS update fails, show error and remain in ToDo state.

### REQ-3a: Done meaning
- Done indicates the implementation plan is complete and waiting for archive.
- Done TFS state remains "活动" (not updated).

### REQ-4: Blocked meaning
- Blocked represents an interrupted or divergent workflow.
- Blocked retains the last `stage` and `subStage` for diagnosis.
- Blocked TFS state remains "活动" (not updated).

### REQ-5: TFS 状态流转 (重要)
- **TFS 状态有两处更新**：
  1. **开始自动化时**：从"已分析"更新为"活动"（REQ-3）
  2. **归档完成时**：从"活动"更新为"已解决"（REQ-5a）
- Progress、Done、Blocked 状态的 TFS 状态都保持为"活动"

### REQ-5a: Archived meaning
- Archived means documentation is archived and code changes are finalized.
- Only after archive completes, update TFS state from "活动" to "已解决".

### REQ-6: Forge artifacts
- Generate artifacts under `forge/tracks/workitem-autorun/`:
  - `intent.md`
  - `design.md`
  - `tasks.md`

### REQ-7: Sync merge
- Task Center sync must preserve local automation states even when TFS query returns only "已分析" items.

### REQ-8: UI 按钮显示规则（问题3）
- **ToDo 状态**: 显示"生成计划"按钮，点击后创建 intent.md + design.md + tasks.md
- **Progress 状态**: 显示"查看计划"按钮，打开 tasks.md 查看执行进度
- **Done 状态**: 显示"查看计划"按钮，查看已完成的执行结果
- **Blocked 状态**: 显示"查看计划"按钮，查看中断位置和错误信息
- **Archived 状态**: 显示"查看归档"按钮，查看最终归档输出

### REQ-9: 逐步执行任务（问题4）
- tasks.md 中的每个任务必须包含执行状态（待执行/执行中/已完成/失败）
- 每个待执行的任务显示"开始执行"按钮
- 任务完成后，自动显示下一个任务的"开始执行"按钮
- 用户可以查看计划文件了解当前执行位置和剩余步骤
- 执行状态实时同步到 UI
