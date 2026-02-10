# Intent: workitem-autorun

## Goal
Automate Task Center ToDo items in TFS state "已分析" through a Forge/openspec-style workflow, while exposing progress sub-stages and archiving outputs. **TFS state is updated twice: first to "活动" when starting automation (clicking "生成计划"), then to "已解决" after archive completes.**

## Scope
- Task Center sync filters (TFS query for "已分析" only)。
- Task Center status semantics (ToDo/Progress/Done/Blocked/Archived)。
- Progress sub-stages using TaskCenterStage + implementing subStage。
- Forge artifacts generation in `forge/tracks/workitem-autorun/`。
- **Automation start updates TFS to "活动"** (when clicking "生成计划").
- Archive completion updates TFS to "已解决"。
- UI 按钮根据状态显示：ToDo 显示"生成计划"，Progress/Done/Blocked 显示"查看计划"。
- 逐步执行任务：每个任务都有"开始执行"按钮，用户可以控制执行节奏。

## Non-goals
- Changing TFS workflow definitions or adding new states.
- Auto-closing work items after resolve.
- CI/CD or deployment automation.

## Success criteria
- ToDo shows only "已分析" items.
- **Clicking "生成计划" updates TFS state to "活动" before creating plan files.**
- Progress shows stage + implementing subStage (TFS state = "活动").
- Done means plan executed and waiting archive (TFS state = "活动").
- Blocked shows failed state with last stage/subStage (TFS state = "活动").
- Archived means docs + code archived; **TFS updated to "已解决"**.

## Constraints
- Use existing OpenWork + OpenCode tool surfaces.
- TFS state changes: "已分析" → "活动" (on start) → "已解决" (on archive).
