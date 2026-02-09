---
name: task-automation
description: TFS 任务自动化流程 - 从 TFS 工作项到代码提交的完整自动化
---

# Task Automation - TFS 任务自动化流程

本技能定义了从 TFS 工作项到代码提交并关联的完整自动化流程。

## 工作流程

### 完整生命周期

```
TFS 工作项 → 任务分析 → 设计生成 → 计划生成 → 代码实现 → 提交 PR → 代码审查 → 归档完成
```

### 阶段定义

| 阶段 | ID | 说明 | 输出 | 输出 |
|------|----|------|------|------|
| **任务分析** | analyze | 提取任务关键信息、理解需求 | task-analysis.json | |
| **设计生成** | design | 创建技术方案文档 | design.md | |
| **计划生成** | plan | 创建实现计划 | plan.md | |
| **代码实现** | implement | 按计划实现代码 | 提交的文件 |
| **代码提交** | commit | 创建 Git 提交 | commit hash |
| **创建 PR** | pr | 创建 Pull Request | PR URL |
| **代码审查** | review | 代码扫描和修复问题 | review-report.json |
| **归档完成** | archive | 更新 TFS 工作项状态 | TFS 更新 |

## 使用方式

### 快速开始

```
"我想要自动化实现 TFS 工作项 #3424142（门诊住院申请单整合-更改请求），按照标准流程完成。"

或

"使用 task-automation skill 实现工作项 #3424142 的完整开发流程：分析、设计、计划、实现、提交、PR、审查、归档。"
```

---

## Phase 1: 任务分析

### 目标

从 TFS 工作项中提取关键信息，理解需求，生成结构化分析。

### 输入

- TFS 工作项 ID
- 工作项类型（Task/Bug/User Story）
- 项目名称

### 执行步骤

1. **获取工作项详情**
   - 调用 TFS API 获取完整信息
   - 提取：标题、描述、验收标准、标签
   - 解析：优先级、分配人员、迭代路径

2. **分析需求**
   - 理解业务场景和用户痛点
   - 识别技术栈和依赖
   - 确定范围和边界条件

3. **提取关键信息**
   - 功能需求列表
   - 技术约束和限制
   - 依赖的系统组件
   - 相关配置和 API

### 输出

创建 `task-analysis.json`：
```json
{
  "tfsWorkItem": {
    "id": 3424142,
    "url": "http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0/_workitems/edit/3424142",
    "title": "...",
    "state": "已建议",
    "project": "WiNEX-Outpatient",
    "assignedTo": "g_wj",
    "type": "任务"
  },
  "analysis": {
    "summary": "一句话总结需求",
    "businessScenario": "业务场景描述",
    "requirements": [
      {
        "id": "req-1",
        "title": "需求标题",
        "description": "详细描述",
        "priority": "high/medium/low",
        "acceptanceCriteria": "验收标准"
      }
    ],
    "technicalContext": {
      "techStack": ["技术栈1", "技术栈2"],
      "dependencies": ["依赖1", "依赖2"],
      "existingComponents": ["组件1", "组件2"],
      "constraints": ["约束1", "约束2"]
    }
  },
  "filesToRead": [
    "path/to/file1.ts",
    "path/to/file2.tsx"
  ]
}
```

### 命令示例

```bash
# 分析特定工作项
"分析 TFS 工作项 #3424142"

# 快速分析（从当前会话上下文中提取）
"分析当前提到的工作项"
```

---

## Phase 2: 设计生成

### 目标

创建技术设计文档，定义解决方案的架构和实现方案。

### 设计文档结构

```markdown
# [工作项标题] - 技术设计

## 概述
- 需求总结
- 技术方案选择
- 实施范围

## 架构设计
- 系统架构图
- 组件划分
- 模块依赖关系

## 接口设计
- 新增/修改的接口列表
- 请求/响应格式
- 错误处理

## 数据模型
- 新增/修改的数据结构
- 数据流图

## 技术实现细节
- 核心算法
- 关键代码片段
- 性能考虑

## 测试策略
- 单元测试范围
- 集成测试场景
- 边界条件

## 风险评估
- 技术风险
- 时间风险
- 缓解措施

## 时间估算
- 各阶段工时估算
- 总工时
- 里程碑
```

### 输出

创建 `design.md`：

```typescript
interface Design {
  overview: string;
  architecture: Architecture;
  interfaces: Interface[];
  dataModels: DataModel[];
  implementation: ImplementationDetail[];
  risks: Risk[];
  timeline: Timeline;
}

interface Architecture {
  diagram: string;
  components: string[];
  dependencies: string[];
}

interface Interface {
  name: string;
  method: string;
  path: string;
  request: Request;
  response: Response;
}

interface Risk {
  type: 'technical' | 'timeline';
  description: string;
  mitigation: string;
}
```

### 命令示例

```bash
# 生成设计方案
"为 #3424142 创建技术设计文档"

# 先分析再设计
"分析 #3424142，然后基于分析结果生成设计"
```

---

## Phase 3: 计划生成

### 目标

创建详细的实现计划，将工作分解为可执行的步骤。

### 计划文档结构

```markdown
# [工作项标题] - 实施计划

## 任务分解

### 1. 环境准备
- [ ] 安装依赖
- [ ] 配置环境变量
- [ ] 初始化数据库

### 2. 核心功能实现
- [ ] 功能模块 1
- [ ] 功能模块 2
- [ ] 功能模块 3

### 3. 集成测试
- [ ] 单元测试
- [ ] 集成测试
- [ ] E2E 测试

### 4. 文档和清理
- [ ] 更新 README
- [ ] 添加注释
- [ ] 清理临时文件

### 步骤详情

每个步骤包括：
- **描述**：要做什么
- **工具/命令**：需要运行的命令或工具
- **预期输出**：应该产生的结果
- **预估时间**：需要的时间
- **验证标准**：如何确认完成

### 依赖关系

```
步骤 A (2h) → 步骤 B (3h) → 步骤 C (1h)
         ↓                    ↓            ↓
     步骤 D (2h) ←──┴── 步骤 E (4h)
         ↓
     步骤 F (3h)
```

### 输出

创建 `plan.md`：

```typescript
interface Plan {
  phases: Phase[];
  timeline: string;
  dependencies: Dependency[];
}

interface Phase {
  id: string;
  name: string;
  description: string;
  steps: Step[];
  estimatedTime: string;
  status: 'pending' | 'in-progress' | 'completed';
}

interface Step {
  id: string;
  order: number;
  title: string;
  description: string;
  command?: string;
  tool?: string;
  artifacts?: string[];
  acceptanceCriteria: string[];
  estimatedTime: string;
}
```

### 命令示例

```bash
# 生成实施计划
"为 #3424142 创建实施计划"

# 基于设计生成计划
"分析 #3424142 生成设计后，基于设计创建计划"

# 完整流程：分析 → 设计 → 计划
"完整处理工作项 #3424142：自动分析、生成设计、创建计划"
```

---

## Phase 4: 代码实现

### 目标

按照计划逐步实现代码，确保每个步骤都有可验证的产出。

### 实现流程

```
对于每个步骤：
1. 读取并理解设计
2. 创建/修改代码
3. 自测验证
4. 提交到 Git
5. 等待验证通过
6. 进入下一步骤
```

### 错误处理

- **编译错误**：立即停止并报告
- **测试失败**：记录日志并重试
- **API 错误**：检查配置和权限
- **数据错误**：验证数据完整性

### 输出

- **代码文件**：创建/修改的源代码
- **测试结果**：测试通过截图或日志
- **提交记录**：Git commit hash

### 命令示例

```bash
# 执行计划
"执行 #3424142 的实施计划"

# 执行特定阶段
"执行 plan.md 中的 Phase 2 - 核心功能实现"

# 跳过已完成的步骤
"继续执行 #3424142 的计划，从步骤 5 开始"
```

---

## Phase 5: 代码提交

### 目标

将代码提交到 Git 仓库，创建有意义的提交信息。

### 提交信息规范

```
[类型] [工作项ID] 标题

详细说明：
- 实现了哪些功能
- 引用了哪些设计文档
- 技术栈和依赖

Co-Authored-By: TaskCenter automation
Related-TFS-Work-Item: #3424142
Related-Design: design.md
Related-Plan: plan.md
```

示例：
```
[feat] #3424142 门诊住院申请单整合-更改请求

实现门诊住院申请单的整合功能模块

- 新增住院申请创建表单
- 新增申请列表查询接口
- 集成患者信息查询服务
- 添加表单验证逻辑

Co-Authored-By: TaskCenter automation
Related-TFS-Work-Work-Item: #342142
Related-Design: design.md
Related-Plan: plan.md
```

### Git 工作流

```bash
# 初始化 Git 仓库
git init

# 创建特性分支
git checkout -b feature/3424142

# 添加文件并提交
git add .
git commit -m "[feat] #3424142 实现门诊住院申请单整合功能"

# 查看提交历史
git log --oneline
```

### 命令示例

```bash
# 提交代码
"为 #3424142 提交代码到 Git"

# 基于计划自动提交
"完成 #3424142 的所有代码实现后，自动提交"
```

---

## Phase 6: 创建 PR

### 目标

创建 Pull Request，关联到 TFS 工作项。

### PR 模板

```markdown
# [工作项ID] [标题]

## 变更概述
- 实现了什么功能
- 涉及的模块和组件
- 主要变更文件列表

## 相关信息
- **TFS 工作项**: #3424142
- **TFS 标题**: 门诊住院申请单整合-更改请求
- **TFS 状态**: 从"已建议" → "活动中"
- **设计文档**: [design.md](#pr-attachment)

## 测试说明
- [x] 本地功能测试通过
- [ ] E2E 测试完成
- [ ] 性能测试通过

## Checklist
- [ ] 代码符合设计文档
- [ ] 单元测试覆盖率 > 80%
- [ ] API 文档已更新
- [ ] 代码审查已通过
- [ ] 性能指标达标

## 截图/链接
（添加相关截图或测试链接）
```

### PR 创建命令

```bash
# 创建 PR
"为 #342142 创建 Pull Request"

# 基于设计创建 PR
"基于 design.md 创建 PR，关联到 TFS 工作项 #342142"
```

---

## Phase 7: 代码审查

### 目标

对代码进行静态分析、安全扫描和审查，发现问题并修复。

### 审查类型

1. **静态代码分析**
   - ESLint/Prettier 检查
   - TypeScript 类型检查
   - 代码复杂度分析

2. **安全扫描**
   - 依赖漏洞扫描
   - 代码安全规则检查
   - SQL 注入检查

3. 人工审查**
   - 代码可读性
   - 架构设计
   - 最佳实践

### 输出

创建 `review-report.json`：

```json
{
  "summary": "审查总结",
  "issues": [
    {
      "severity": "high/medium/low",
      "category": "code-quality/security/performance",
      "title": "问题标题",
      "file": "文件路径",
      "line": 10,
      "description": "问题描述",
      "suggestion": "修复建议"
    }
  ],
  "metrics": {
    "codeCoverage": "85%",
    "complexity": "medium",
    "securityScore": "A"
  },
  "recommendation": "可以通过/不通过"
}
```

### 命令示例

```bash
# 运行代码审查
"对 #3424142 的 PR 进行代码审查"

# 运行静态分析
"对 #342142 的代码进行 ESLint 检查"

# 安全扫描
"对 #3424142 进行安全漏洞扫描"
```

---

## Phase 8: 归档完成

### 目标

更新 TFS 工作项状态，标记为已关闭，添加最终备注。

### 状态流转

```
"已建议" (New) → "活动中" (Active) → "已解决" (Resolved) → "已关闭" (Closed)
```

### 归档内容

```bash
# 标记工作项为已解决并添加 PR 链接
"将 #342142 标记为已解决，并关联 PR https://tfs/.../pullrequest/1"

# 更新为已关闭（可选）
"将 #34214142 标记为已关闭，添加备注：代码已合并到 main 分支"
```

### 最终命令

```bash
# 完整自动化流程
"使用 task-automation skill 完整处理工作项 #3424142"

# 快速模式：仅分析和设计
"分析并设计工作项 #3424142，不执行实现"

# 仅实现模式：从计划开始
"跳过分析设计，直接执行 #3424142 的实施计划"
```

---

## 工具集成

本技能使用以下 TFS 工具：

- **query-my-workitems.mjs** - 查询工作项
- **task-center-integration.mjs** - 工作项管理
- **tfs-client.mjs** - TFS API 封装

---

## 配置要求

确保 TFS 配置文件 `config/tfs-config.json` 存在：

```json
{
  "serverUrl": "http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0",
  "pat": "your-pat-token",
  "taskCenterBranch": "feature/{workItemId}"
}
```

---

## 注意事项

1. **权限验证**
   - 检查 PAT Token 权限
   - 确认代码库访问权限
   - 验证 TFS 写入权限

2. **环境检查**
   - Node.js 版本 >= 18
   - Git 版本 >= 2.30
   - 必要的依赖已安装

3. **数据备份**
   - 重要操作前创建备份
   - 避免覆盖重要代码
   - 保留历史提交

4. **回滚准备**
   - 保留原始代码
   - 测试失败时快速恢复
   - 维护稳定的 main 分支
