# Skill: forge-orchestrator

**用途**: 编排 TFS 工作项的完整自动化流程，包括计划生成、任务执行和归档。

## 触发条件

当用户在 Task Center 点击"生成计划"或"查看计划"按钮时，OpenWork 会使用此 skill。

## 工作流程

```
1. 分析工作项 (analyzing)
   - 读取 TFS 工作项详情
   - 分析需求和上下文
   
2. 生成计划 (planning)
   - 创建 forge/tracks/workitem-autorun/tfs-{id}/plan.md
   - 创建 forge/tracks/workitem-autorun/tfs-{id}/tasks.md
   
3. 执行计划 (implementing)
   - 逐个执行 tasks.md 中的任务
   - 更新任务状态
   
4. 归档完成 (archiving)
   - 执行 forge-archive
   - 更新 TFS 状态为"已解决"
```

## 使用方法

在 OpenCode session 中提示：

```
使用 forge-orchestrator 处理 TFS 工作项 #{tfsId}
```

或者直接使用工具：

```javascript
node .opencode/skills/forge-orchestrator/tools/forge-orchestrator.mjs start {tfsId}
```

## 命令

- `start {tfsId}` - 开始处理工作项（分析→生成计划）
- `execute {tfsId} {taskIndex}` - 执行指定任务
- `complete {tfsId} {taskIndex}` - 标记任务完成
- `archive {tfsId}` - 归档完成的工作项

## 状态流转

```
已分析 → 活动（开始自动化时）→ 已解决（归档后）
```

## 文件结构

```
forge/tracks/workitem-autorun/
└── tfs-{id}/
    ├── plan.md       # 计划文档
    ├── tasks.md      # 任务列表
    ├── changes/      # 变更目录
    └── ARCHIVE.md    # 归档文档（完成后生成）
```
