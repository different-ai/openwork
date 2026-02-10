# Design: workitem-autorun

## Overview
This change aligns Task Center with a Forge/openspec workflow for work items in TFS state "已分析". It introduces a stable column meaning (ToDo/Progress/Done/Blocked/Archived) and adds sub-stage visibility during implementation. **TFS state is updated twice: first to "活动" when automation starts, then to "已解决" after archive completes.**

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
   - **Progress**: automation active; stage shown. **TFS state = "活动"**
   - **Done**: plan executed, waiting archive. **TFS state = "活动"**
   - **Blocked**: workflow interrupted; show last stage/subStage. **TFS state = "活动"**
   - **Archived**: archive complete; update TFS to "已解决". **TFS state = "已解决"

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
- **On automation start: update TFS state from "已分析" to "活动"**
- Create or update `intent.md`, `design.md`, `tasks.md` in the track.
- Update automation state per phase (stage/subStage).
- On archive completion, update TFS state to "已解决".
- On failure, set status=failed and record `blockedReason`.

## UI changes
- Show stage badge under each card in Progress/Blocked/Done/Archived.
- Show subStage only when stage=implementing.
- Keep the existing columns and tones; no new columns.

## TFS 状态流转（重要变更）

### 状态流转图

```
已分析 (ToDo) 
    ↓ 点击"生成计划" - 更新TFS为"活动"
活动 (Progress/Done/Blocked)
    ↓ 归档完成 - 更新TFS为"已解决"
已解决 (Archived)
```

### 流转规则

| Task Center 状态 | TFS 状态 | 触发条件 | 行为 |
|------------------|----------|----------|------|
| **ToDo** | 已分析 | 初始状态 | 只查询，不修改 |
| **Progress** | 活动 | 点击"生成计划"按钮 | **更新 TFS 为"活动"，然后创建计划文件** |
| **Done** | 活动 | 所有任务执行完成 | 不修改 TFS |
| **Blocked** | 活动 | 任务执行失败 | 不修改 TFS |
| **Archived** | 已解决 | 用户点击"归档" | **更新 TFS 为"已解决"** |

### 关键说明

1. **两次 TFS 更新**
   - **第一次**：点击"生成计划"时，更新为"活动"
   - **第二次**：归档完成时，更新为"已解决"

2. **活动中保持**
   - Progress、Done、Blocked 状态的 TFS 状态都保持为"活动"
   - 这些状态只在 Task Center 本地跟踪，不映射回 TFS

3. **更新失败处理**
   - 如果更新 TFS 为"活动"失败，显示错误并保持在 ToDo
   - 不创建计划文件，不移动到 Progress

## UI 交互设计（问题3：查看计划按钮）

### 按钮显示规则

| 状态列 | 按钮文本 | 按钮行为 | 条件 |
|--------|----------|----------|------|
| **ToDo** | "生成计划" | 创建 `intent.md` → `design.md` → `tasks.md` | 工作项在"已分析"状态，且无现有计划 |
| **Progress** | "查看计划" | 打开 `tasks.md` 查看当前进度 | 计划已生成，正在执行中 |
| **Done** | "查看计划" | 打开 `tasks.md` 查看执行结果 | 计划执行完成，等待归档 |
| **Blocked** | "查看计划" | 打开 `tasks.md` 查看中断位置 | 执行被中断 |
| **Archived** | "查看归档" | 打开归档目录查看最终输出 | 归档完成 |

### ToDo 状态的工作项
- ToDo 列的工作项还没有生成计划
- 显示"生成计划"按钮
- 点击后触发 forge-orchestrator 创建计划文档
- 计划生成完成后，工作项自动移动到 Progress 列

### 计划文件查看方式
- 点击"查看计划"按钮打开计划文件（`tasks.md`）
- 使用 Monaco Editor 或简单预览面板显示
- 在计划中高亮显示当前执行到的步骤

## 逐步执行流程（问题4）

### 核心变更：从全自动到逐步执行

原设计：一次性执行所有任务步骤
新设计：每个任务步骤都有"开始执行"按钮，用户可以控制执行节奏

### 步骤执行状态机

```
[待执行] → [执行中] → [已完成] → [下一步待执行]
              ↓
          [执行失败] → [Blocked]
```

### tasks.md 格式扩展

每个任务需要包含执行状态：

```markdown
### Task 1: 分析需求

**状态**: ⏳ 待执行 | 🔄 执行中 | ✅ 已完成 | ❌ 失败

**描述**: ...

**[开始执行]**  ← 按钮（只在待执行状态显示）
```

### 执行流程

1. **初始化阶段**
   - 用户点击 ToDo 项的"生成计划"
   - **首先：调用 TFS API 更新工作项状态为"活动"**
   - 然后：forge-orchestrator 创建 intent.md + design.md + tasks.md
   - 工作项移动到 Progress 列
   - Stage = "planning", SubStage = null

2. **逐步执行阶段**
   - 用户点击第一个任务的"开始执行"
   - Stage 更新（如 "analyzing"）
   - 任务状态变为"执行中"
   - 执行完成后，任务状态变为"已完成"
   - 下一个任务显示"开始执行"按钮

3. **用户控制点**
   - 每个任务开始前，用户可以查看计划
   - 每个任务完成后，用户可以确认或重试
   - 用户可以随时暂停/继续（通过 Blocked 状态）

4. **归档阶段**
   - 所有任务完成后，显示"归档"按钮
   - 用户点击归档，执行归档流程
   - 归档完成后，更新 TFS 状态为"已解决"
   - 工作项移动到 Archived 列

### UI 更新

Progress 列卡片显示：
- 当前 Stage（如：分析、设计、实现）
- 当前任务名称
- "查看计划"按钮
- （如果是自动化执行中）显示进度指示器

### 技术实现

需要新增：
1. `tasks.md` 解析器 - 读取和更新任务状态
2. 步骤执行控制器 - 管理步骤间的流转
3. UI 状态同步 - 根据 tasks.md 更新卡片状态

## Error handling
- If a phase fails, mark the item as Blocked with last stage/subStage and error message.
- Do not update TFS state on failures.

## Verification
- Typecheck for UI changes.
- Unit tests for merge logic and status mapping if test harness is added.
