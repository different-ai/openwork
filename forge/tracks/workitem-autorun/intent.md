# Intent: workitem-autorun

## Goal
Automate Task Center ToDo items in TFS state "已分析" through a Forge/openspec-style workflow, while exposing progress sub-stages and archiving outputs. Only after archive completes, update TFS state to "已解决".

## Scope
- Task Center sync filters (TFS query for "已分析" only).
- Task Center status semantics (ToDo/Progress/Done/Blocked/Archived).
- Progress sub-stages using TaskCenterStage + implementing subStage.
- Forge artifacts generation in `forge/tracks/workitem-autorun/`.
- Archive completion updates TFS to "已解决".

## Non-goals
- Changing TFS workflow definitions or adding new states.
- Auto-closing work items after resolve.
- CI/CD or deployment automation.

## Success criteria
- ToDo shows only "已分析" items.
- Progress shows stage + implementing subStage.
- Done means plan executed and waiting archive.
- Blocked shows failed state with last stage/subStage.
- Archived means docs + code archived; TFS updated to "已解决".

## Constraints
- Do not update TFS state before archive completes.
- Use existing OpenWork + OpenCode tool surfaces.
