---
name: |
  tfs2018-integration
description: |
  TFS 2018 集成技能：工作项管理与代码提交检查（卫宁健康 WINNING-6.0 团队项目）
---

# TFS 2018 Integration (卫宁健康)

本技能为卫宁健康 WINNING-6.0 团队提供 TFS 2018 集成，支持工作项管理和代码提交检查。

## 服务器配置（内置）

**服务器地址**: `http://tfs2018-web.winning.com.cn:8080/tfs/`

**集合**: `WINNING-6.0`

**完整 URL**: `http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0`

## 首次使用 - 认证配置

本技能使用相对路径存储配置，配置文件位于技能目录内，支持跨电脑迁移。

### 获取 PAT Token

1. 登录 TFS: http://tfs2018-web.winning.com.cn:8080/tfs/
2. 点击右上角用户头像 → **安全** → **+添加** → **个人访问令牌**
3. 设置令牌名称（如 "Claude Code"）和有效期
4. 选择权限：**工作项** (读取、管理)、**代码** (读取)
5. 复制生成的令牌

### 配置文件

配置文件位于技能目录内（相对于 SKILL.md）：

```
./config/tfs-config.json
```

配置文件格式：

```json
{
  "serverUrl": "http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0",
  "pat": "your-personal-access-token"
}
```

> **注意**: `tfs-config.json` 需要你首次使用时创建。配置文件随技能目录一起存储，可随技能一起迁移到其他电脑。

### 使用 Claude Code 配置

首次使用时，直接告诉我：

- "配置 TFS 认证信息，PAT 是 xxx"

我会自动创建配置文件。

## 项目列表（内置）

| 项目名称                     | 项目ID                                 | 描述                                               |
| ---------------------------- | -------------------------------------- | -------------------------------------------------- |
| OA4.0                        | `4150312b-3a53-4da7-a8a7-e2bfe7fd970f` | OA系统                                             |
| win-cloud                    | `b46e3a4d-0b96-4d7b-aa4a-216121a1ef73` | -                                                  |
| WiNEX-Copilot                | `a3f67cbb-d375-4a58-a6c8-da448150c495` | -                                                  |
| 售前演示                     | `ddbd09b1-59ea-420d-843d-2f70ef9aa8e8` | -                                                  |
| WiNEX-DCP                    | `f4e79b7d-13e6-4e47-9a17-570d72d4f6ef` | 数据中台                                           |
| W.in-DEMO                    | `fa4a1591-32d3-4e3f-82c2-761005d119a2` | 6.0技术和原型验证项目                              |
| WiNEX-PatientInterests       | `6a84d2a9-b5ce-44e5-bce0-171ad6cd96e1` | 患者权益管理系统                                   |
| W.in-MVP                     | `8c3c22dc-6d35-49b5-8589-3375adb60a84` | 卫宁6.0产品首批交付项目                            |
| WiNEX-MDM                    | `aa8c3418-9ec5-4c9e-8209-e229aeda3cfa` | 卫宁主数据                                         |
| HUMANITY                     | `595b77d4-6f9a-46cf-9aeb-ea2afdef59d6` | 厦门弘爱                                           |
| WiNEX-Cloud                  | `d4361d76-6ff9-4fc3-851c-536d9305c40c` | -                                                  |
| WiNEX-MiddlePlatform         | `8ef8a81d-59bd-455e-a86c-2687ba9b6e03` | WiNEX业务中台                                      |
| WiNEX-Inpatient-2            | `fa2bf9fc-fdc9-4167-ae72-feef8525e1f5` | -                                                  |
| WiNEX-Outpatient             | `e17bb6a1-2677-4695-8202-c3c296bbd05c` | 门诊医生站                                         |
| WiNEX-General                | `250f7599-5c8c-4e93-892c-71157224ae73` | -                                                  |
| WiNEX-Integration            | `7c4d1061-6885-4c24-8096-1e1fc9795432` | 集成组相关项目（FHIR对接、主数据对接、第三方接口） |
| MiddlePlatform               | `5c6e7482-f12f-418d-8994-bc5aeaea75a8` | -                                                  |
| WiNEX-CaseHistory            | `739645d0-5770-4efc-98d3-33c98e749837` | 6.0病案                                            |
| Public Query                 | `bad35cc1-f0d6-4f80-8ba0-6f166b3ef6be` | 仅做公共共享查询                                   |
| WiNEX_WXP                    | `89f17307-4986-4251-a04f-e534f9a1b99d` | -                                                  |
| UED                          | `58e8e9b0-5975-48d2-af2d-2719222c7ff0` | UED                                                |
| WiNEX-Inpatient              | `9e4a971d-4027-4c9a-b55b-f0b74487afb5` | 住院大临床项目                                     |
| WiNEX-Triage                 | `af9ab1c7-72ef-42cf-91a3-ef771be43f5a` | WiNEX门诊护士站                                    |
| WiNEX-Emergency              | `5f498025-58dd-4ba0-8137-3fc962e1acaf` | WINEX 急诊                                         |
| WiNEX-Management             | `e92e726a-8dbe-4385-998f-58182a4ddb1c` | 智慧管理类产品                                     |
| WiNEX-Taikang                | `af798a82-646e-467a-8f90-8f3b2c9c39a4` | 泰康合作人员专用项目                               |
| WiNEX-BasicInfoService       | `7dfa9b49-818c-4765-8aae-aec1304af4e9` | -                                                  |
| WiNEX-Specialized            | `8f70e3be-75e3-4969-a3fb-93481dc2c589` | WiNEX专科项目                                      |
| WINEX-ConfigManage           | `18eb3c40-2667-435f-80df-51ce43b24935` | -                                                  |
| WiNEX-HospitalAdministration | `6dcd7f28-99b5-4f43-8877-82230e999906` | -                                                  |
| WiNEX-MY                     | `6cdb1969-bbbc-4ea2-818a-ae29389df42e` | -                                                  |

## TFS 2018 限制与注意事项

### WIQL 查询限制

1. **日期格式**: TFS 2018 要求日期格式为 `YYYY-MM-DD`，不能包含时间部分

   ```javascript
   // 正确的格式
   AND[System.ChangedDate] >= '2026-01-07'

   // 错误的格式（会导致查询失败）
   AND[System.ChangedDate] >= '2026-01-07T10:30:00Z'
   ```

2. **不支持的字段**: TFS 2018 不支持以下字段
   - `System.ClosedDate` - 已关闭日期
   - `System.ResolvedDate` - 已解决日期
   - 替代方案：使用 `System.ChangedDate` 进行日期过滤

### Git API 限制

1. **日期过滤**: `getCommits` API 的 `fromDate` 和 `toDate` 参数在 TFS 2018 中可能不工作
   - 解决方案：客户端已实现日期过滤逻辑
   - 使用 `getCommits(repoId, project, top, days)` 方法，其中 `days` 参数会在客户端进行过滤

2. **性能考虑**: 获取提交详细变更（`getChanges`）非常耗时
   - 建议避免批量获取每个提交的详细变更
   - 优先使用提交中的 `workItems` 数组来判断工作项关联

### 推荐实践

```javascript
// 获取近10天的已解决工作项
const resolvedItems = await client.getRecentResolvedWorkItems(
  'WiNEX-Outpatient', // 项目名称
  10, // 最近10天
  ['Resolved', 'Closed'] // 状态列表
)

// 获取近7天的代码提交（客户端日期过滤）
const commits = await client.getCommits(
  repositoryId,
  project,
  100, // 获取数量
  7 // 最近7天，会自动过滤
)
```

## 使用方式

### 通过 Claude Code 直接操作

你可以直接要求我执行工作项操作，例如：

- "查询 WiNEX-Outpatient 项目中分配给我的任务"
- "获取工作项 12345 的详细信息"
- "查询 OA4.0 项目中所有未关闭的 Bug"
- "更新工作项 12345 的状态为进行中"
- "检查 WiNEX-Integration 项目最近的代码提交"

### 工作项查询示例

```javascript
// 按 ID 查询单个工作项
async function getWorkItem(id) {
  const witApi = await connection.getWorkItemTrackingApi()
  return await witApi.getWorkItem(id, null, null, null, ['All'])
}

// 查询分配给我的活动任务
async function getMyTasks(project) {
  const witApi = await connection.getWorkItemTrackingApi()
  const wiql = `
    SELECT [System.Id], [System.Title], [System.State]
    FROM WorkItems
    WHERE [System.WorkItemType] = 'Task'
    AND [System.State] <> 'Closed'
    AND [System.AssignedTo] = @me
    AND [System.TeamProject] = '${project}'
    ORDER BY [System.ChangedDate] DESC
  `
  const result = await witApi.queryByWiql({ query: wiql })
  const ids = result.workItems.map((wi) => wi.id)
  return await witApi.getWorkItems(ids, null, null, 'All')
}

// 使用示例
const tasks = await getMyTasks('WiNEX-Outpatient')
console.log(`找到 ${tasks.length} 个任务`)
```

### 创建工作项

```javascript
async function createTask(project, title, description, assignedTo) {
  const witApi = await connection.getWorkItemTrackingApi()
  const document = [
    { op: 'add', path: '/fields/System.Title', value: title },
    { op: 'add', path: '/fields/System.Description', value: description || '' },
    { op: 'add', path: '/fields/System.AssignedTo', value: assignedTo || '' },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: '2' },
  ]
  return await witApi.createWorkItem(null, document, project, 'Task')
}
```

### 更新工作项状态

```javascript
async function updateState(id, newState, comment) {
  const witApi = await connection.getWorkItemTrackingApi()
  const document = [{ op: 'replace', path: '/fields/System.State', value: newState }]
  if (comment) {
    document.push({ op: 'add', path: '/fields/System.History', value: comment })
  }
  return await witApi.updateWorkItem(null, document, id)
}
```

### 代码提交检查

```javascript
// 获取项目的 Git 仓库
async function getRepositories(project) {
  const gitApi = await connection.getGitApi()
  return await gitApi.getRepositories(project)
}

// 获取最近的提交记录
async function getRecentCommits(project, repositoryId, top = 20) {
  const gitApi = await connection.getGitApi()
  return await gitApi.getCommits(repositoryId, project, null, null, null, top)
}

// 检查提交是否关联工作项
async function checkCommitWorkItems(repositoryId, projectId, commitId) {
  const gitApi = await connection.getGitApi()
  const commit = await gitApi.getCommit(commitId, repositoryId, projectId)
  const workItems = commit.workItems || []
  return {
    hasWorkItems: workItems.length > 0,
    workItemCount: workItems.length,
    workItems: workItems,
  }
}
```

## 工具文件

技能目录包含以下可执行工具（相对于技能目录）：

| 文件                   | 说明                  |
| ---------------------- | --------------------- |
| `tools/tfs-client.mjs` | 完整的 TFS 客户端封装 |
| `tools/tfs-query.mjs`  | 命令行查询工具        |

## 常见工作项类型和字段

### 工作项类型

- **Task** (任务): New, Active, Closed
- **Bug** (缺陷): New, Active, Resolved, Closed
- **User Story** (用户故事): New, Active, Resolved, Closed

### 常用字段

```
System.Title - 标题
System.Description - 描述
System.State - 状态
System.AssignedTo - 分配给
System.WorkItemType - 工作项类型
System.TeamProject - 所属项目
Microsoft.VSTS.Common.Priority - 优先级 (1, 2, 3)
```

## 任务控制中心集成 (Task Center Integration)

本技能现已支持 **OpenWork 任务控制中心看板** 集成，提供完整的工作项生命周期管理能力。

### 快速开始

#### 1. 配置认证信息

**方式一：交互式配置（推荐）**
```bash
node tools/setup-config.mjs
```
按照向导输入：
- Server URL（默认已填）
- PAT Token（从 TFS 获取）
- Username（可选，用于显示）

**方式二：快速配置**
```bash
# 仅配置 PAT
node tools/setup-config.mjs your-pat-token

# 配置 PAT 和用户名
node tools/setup-config.mjs your-pat-token "张三"
```

**方式三：手动创建配置文件**

创建 `config/tfs-config.json` 文件：
```json
{
  "serverUrl": "http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0",
  "pat": "your-personal-access-token",
  "username": "your-name"
}
```

#### 2. 验证配置

```bash
# 检查配置并测试连接
node tools/setup-config.mjs --check
```

#### 3. 查看当前配置

```bash
# 显示当前配置的账号信息
node tools/setup-config.mjs --show
```

#### 4. 获取 PAT Token

1. 登录 TFS: http://tfs2018-web.winning.com.cn:8080/tfs/
2. 点击右上角用户头像 → **安全** → **+添加** → **个人访问令牌**
3. 设置令牌名称（如 "Task Center"）和有效期
4. 选择权限：
   - **工作项**: 读取、写入、管理
   - **代码**: 读取、写入
5. 复制生成的令牌

#### 5. 查询我的工作项

```bash
# 列出所有分配给我的任务
node tools/query-my-workitems.mjs

# 指定项目
node tools/query-my-workitems.mjs WiNEX-Outpatient

# 指定状态
node tools/query-my-workitems.mjs WiNEX-Outpatient New,Active,Resolved
```

### 功能特性

- **批量获取工作项**: 支持按状态、类型、日期过滤
- **完整工作项详情**: 包含描述、验收标准、标签等
- **状态流转管理**: ToDo → Progress → Done → Archived
- **PR 关联**: 自动关联 Pull Request 到工作项
- **执行历史**: 查看工作项的所有变更记录

### 工具文件

| 文件 | 说明 |
|------|------|
| `tools/task-center-integration.mjs` | 任务控制中心专用客户端 |
| `tools/tfs-client.mjs` | 基础 TFS 客户端 |

### 通过 Claude Code 操作任务

#### 获取我的工作项

```
查询 WiNEX-Outpatient 项目中分配给我的活动任务
```

```javascript
// 使用 task-center-integration 工具
const client = new TaskCenterTFSClient();

const tasks = await client.getMyWorkItems({
  project: 'WiNEX-Outpatient',
  states: ['New', 'Active'],
  workItemTypes: ['Task', 'Bug'],
  top: 50
});

console.log(`找到 ${tasks.length} 个任务`);
```

#### 获取工作项详情

```
获取工作项 12345 的详细信息
```

```javascript
const detail = await client.getWorkItemDetail(12345);

console.log(`ID: #${detail.id}`);
console.log(`Title: ${detail.title}`);
console.log(`State: ${detail.state}`);
console.log(`Priority: P${detail.priority}`);
console.log(`Description: ${detail.description}`);
console.log(`Acceptance Criteria: ${detail.acceptanceCriteria}`);
```

#### 状态流转操作

**开始处理任务 (ToDo → Progress)**

```
将工作项 12345 标记为进行中
```

```javascript
const result = await client.activateWorkItem(12345);
// 自动添加评论: "任务已开始处理 (via Task Center)"
```

**完成任务 (Progress → Done)**

```
将工作项 12345 标记为已解决，并关联 PR https://tfs/.../pullrequest/1
```

```javascript
const result = await client.resolveWorkItem(12345, {
  prUrl: 'https://tfs/.../pullrequest/1',
  prTitle: 'Fix login bug'
});
// 状态变为 Resolved，并关联 PR
```

**关闭任务 (Done → Archived)**

```
将工作项 12345 标记为已关闭
```

```javascript
const result = await client.closeWorkItem(12345);
// 状态变为 Closed
```

#### 批量操作

```javascript
// 批量获取多个工作项详情
const ids = [12345, 12346, 12347];
const details = await client.getWorkItemsDetails(ids);

// 获取项目所有工作项（管理员）
const allItems = await client.getAllProjectWorkItems('WiNEX-Outpatient', {
  states: ['New', 'Active', 'Resolved'],
  days: 30
});
```

#### 查询与代码关联的工作项

```javascript
// 获取最近 7 天与代码提交关联的工作项
const result = await client.getWorkItemsLinkedToCommits(
  'repo-id',
  'WiNEX-Outpatient',
  7
);

console.log(`找到 ${result.commits.length} 个关联提交`);
console.log(`涉及 ${result.workItems.length} 个工作项`);
```

### 命令行工具

```bash
# 列出我的工作项
node tools/task-center-integration.mjs list WiNEX-Outpatient

# 显示工作项详情
node tools/task-center-integration.mjs show 12345

# 状态操作
node tools/task-center-integration.mjs activate 12345
node tools/task-center-integration.mjs resolve 12345 https://tfs/.../pullrequest/1
node tools/task-center-integration.mjs close 12345

# 查看历史
node tools/task-center-integration.mjs history 12345
```

### 任务控制中心数据格式

工具返回的标准化工作项格式：

```typescript
{
  id: number;                    // 工作项 ID
  title: string;                 // 标题
  description: string;           // 描述
  state: string;                 // 当前状态
  workItemType: string;          // 类型 (Task/Bug/User Story)
  assignedTo: string;            // 分配给
  priority: number;              // 优先级 (1-4)
  project: string;               // 所属项目
  createdDate: string;           // 创建时间
  changedDate: string;           // 修改时间
  tags: string[];                // 标签列表
  url: string;                   // TFS 链接
  
  // 详细信息时包含
  acceptanceCriteria?: string;   // 验收标准
  areaPath?: string;             // 区域路径
  iterationPath?: string;        // 迭代路径
  createdBy?: string;            // 创建者
  changedBy?: string;            // 修改者
}
```

## CLI Commands

```bash
# Add user content
skill-creator add-skill --pwd "./tfs2018-integration" --title "Title" --content "Content"

# Search documentation
skill-creator search-skill --pwd "./tfs2018-integration" "query"

# Task Center Integration
node tools/task-center-integration.mjs list [project] [states]
node tools/task-center-integration.mjs show <id>
node tools/task-center-integration.mjs activate <id>
node tools/task-center-integration.mjs resolve <id> [pr-url]
node tools/task-center-integration.mjs close <id>
```

## User Skills

<user-skills baseDir="assets/references/user">
- content.md
</user-skills>

## Context7 Documentation

<!-- Context7 projects will be listed here automatically -->
