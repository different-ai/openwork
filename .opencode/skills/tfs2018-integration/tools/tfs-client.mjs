#!/usr/bin/env node
/**
 * TFS 2018 Client Wrapper
 * 卫宁健康 WINNING-6.0 团队
 *
 * 用于与 TFS 2018 服务器交互的客户端封装
 * 配置文件: ./config/tfs-config.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import azureDevOps from 'azure-devops-node-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 服务器配置（内置）
const DEFAULT_SERVER_URL = 'http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0';

// 内置项目列表
const PROJECTS = {
  'OA4.0': '4150312b-3a53-4da7-a8a7-e2bfe7fd970f',
  'win-cloud': 'b46e3a4d-0b96-4d7b-aa4a-216121a1ef73',
  'WiNEX-Copilot': 'a3f67cbb-d375-4a58-a6c8-da448150c495',
  '售前演示': 'ddbd09b1-59ea-420d-843d-2f70ef9aa8e8',
  'WiNEX-DCP': 'f4e79b7d-13e6-4e47-9a17-570d72d4f6ef',
  'W.in-DEMO': 'fa4a1591-32d3-4e3f-82c2-761005d119a2',
  'WiNEX-PatientInterests': '6a84d2a9-b5ce-44e5-bce0-171ad6cd96e1',
  'W.in-MVP': '8c3c22dc-6d35-49b5-8589-3375adb60a84',
  'WiNEX-MDM': 'aa8c3418-9ec5-4c9e-8209-e229aeda3cfa',
  'HUMANITY': '595b77d4-6f9a-46cf-9aeb-ea2afdef59d6',
  'WiNEX-Cloud': 'd4361d76-6ff9-4fc3-851c-536d9305c40c',
  'WiNEX-MiddlePlatform': '8ef8a81d-59bd-455e-a86c-2687ba9b6e03',
  'WiNEX-Inpatient-2': 'fa2bf9fc-fdc9-4167-ae72-feef8525e1f5',
  'WiNEX-Outpatient': 'e17bb6a1-2677-4695-8202-c3c296bbd05c',
  'WiNEX-General': '250f7599-5c8c-4e93-892c-71157224ae73',
  'WiNEX-Integration': '7c4d1061-6885-4c24-8096-1e1fc9795432',
  'MiddlePlatform': '5c6e7482-f12f-418d-8994-bc5aeaea75a8',
  'WiNEX-CaseHistory': '739645d0-5770-4efc-98d3-33c98e749837',
  'Public Query': 'bad35cc1-f0d6-4f80-8ba0-6f166b3ef6be',
  'WiNEX_WXP': '89f17307-4986-4251-a04f-e534f9a1b99d',
  'UED': '58e8e9b0-5975-48d2-af2d-2719222c7ff0',
  'WiNEX-Inpatient': '9e4a971d-4027-4c9a-b55b-f0b74487afb5',
  'WiNEX-Triage': 'af9ab1c7-72ef-42cf-91a3-ef771be43f5a',
  'WiNEX-Emergency': '5f498025-58dd-4ba0-8137-3fc962e1acaf',
  'WiNEX-Management': 'e92e726a-8dbe-4385-998f-58182a4ddb1c',
  'WiNEX-Taikang': 'af798a82-646e-467a-8f90-8f3b2c9c39a4',
  'WiNEX-BasicInfoService': '7dfa9b49-818c-4765-8aae-aec1304af4e9',
  'WiNEX-Specialized': '8f70e3be-75e3-4969-a3fb-93481dc2c589',
  'WINEX-ConfigManage': '18eb3c40-2667-435f-80df-51ce43b24935',
  'WiNEX-HospitalAdministration': '6dcd7f28-99b5-4f43-8877-82230e999906',
  'WiNEX-MY': '6cdb1969-bbbc-4ea2-818a-ae29389df42e'
};

/**
 * 获取配置文件路径
 */
function getConfigPath() {
  // 相对于工具文件的位置，找到 config 目录
  const toolDir = __dirname;
  const skillDir = path.dirname(toolDir);
  return path.join(skillDir, 'config', 'tfs-config.json');
}

/**
 * 格式化日期为TFS WIQL格式 (TFS 2018 需要日期格式 YYYY-MM-DD，不能包含时间部分)
 */
function formatDateForWIQL(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeUsername(username) {
  if (!username) return null;
  if (username.includes('\\')) return username;
  return `WINNING\\${username}`;
}

/**
 * 加载配置
 */
function loadConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error(
      '配置文件不存在: ' + configPath + '\n' +
      '请先创建配置文件，格式如下:\n' +
      '{\n' +
      '  "serverUrl": "YOUR_TFS_SERVER_URL",\n' +
      '  "pat": "your-personal-access-token"\n' +
      '}\n\n' +
      '获取 PAT Token:\n' +
      '1. 登录 TFS: YOUR_TFS_BASE_URL\n' +
      '2. 用户头像 → 安全 → +添加 → 个人访问令牌\n' +
      '3. 选择权限: 工作项(读取、管理)、代码(读取)'
    );
  }

  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(configContent);

  return {
    serverUrl: config.serverUrl || DEFAULT_SERVER_URL,
    pat: config.pat,
    username: config.username || null
  };
}

/**
 * 保存配置
 */
function saveConfig(serverUrl, pat) {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  // 确保目录存在
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const config = {
    serverUrl: serverUrl || DEFAULT_SERVER_URL,
    pat: pat
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('配置已保存到:', configPath);
}

/**
 * TFS 客户端类
 */
class TFSClient {
  constructor() {
    const config = loadConfig();
    this.serverUrl = config.serverUrl;
    this.authHandler = azureDevOps.getPersonalAccessTokenHandler(config.pat);
    this.connection = new azureDevOps.WebApi(this.serverUrl, this.authHandler);
    this.witApi = null;
    this.gitApi = null;
    this.username = normalizeUsername(config.username);
  }

  getAssignedToClause() {
    if (this.username) {
      return `[System.AssignedTo] = '${this.username}'`;
    }
    return `[System.AssignedTo] = @me`;
  }

  /**
   * 获取工作项跟踪 API
   */
  async getWorkItemApi() {
    if (!this.witApi) {
      this.witApi = await this.connection.getWorkItemTrackingApi();
    }
    return this.witApi;
  }

  /**
   * 获取 Git API
   */
  async getGitApi() {
    if (!this.gitApi) {
      this.gitApi = await this.connection.getGitApi();
    }
    return this.gitApi;
  }

  /**
   * 按 ID 获取单个工作项
   * API: getWorkItem(id, fields, asOf, expand, project)
   */
  async getWorkItem(id, project = null) {
    const witApi = await this.getWorkItemApi();
    return await witApi.getWorkItem(id, null, null, 'All', project);
  }

  /**
   * 批量获取工作项
   * API: getWorkItems(ids, fields, asOf, expand, errorPolicy, project)
   */
  async getWorkItems(ids, project = null) {
    const witApi = await this.getWorkItemApi();
    return await witApi.getWorkItems(ids, null, null, 'All', null, project);
  }

  /**
   * 使用 WIQL 查询工作项
   */
  async queryWorkItems(wiql, project = null) {
    const witApi = await this.getWorkItemApi();
    const queryResult = await witApi.queryByWiql({ query: wiql });

    if (!queryResult.workItems || queryResult.workItems.length === 0) {
      return [];
    }

    const ids = queryResult.workItems.map(wi => wi.id);
    const resolvedProject = project || undefined;
    const batchSize = 200;
    const results = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const items = await witApi.getWorkItems(batch, null, null, 'All', null, resolvedProject);
      if (!Array.isArray(items)) {
        throw new Error('TFS query returned no work item details. Check PAT and project permissions.');
      }
      results.push(...items);
    }
    return results;
  }

  /**
   * 查询分配给我的活动任务
   */
  async getMyTasks(project = null) {
    let wiql = `
      SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
      FROM WorkItems
      WHERE [System.WorkItemType] = 'Task'
      AND [System.State] <> 'Closed'
      AND ${this.getAssignedToClause()}
    `;

    if (project) {
      wiql += ` AND [System.TeamProject] = '${project}'`;
    }

    wiql += ' ORDER BY [System.ChangedDate] DESC';

    return await this.queryWorkItems(wiql, project);
  }

  /**
   * 查询未关闭的 Bug
   */
  async getOpenBugs(project = null) {
    let wiql = `
      SELECT [System.Id], [System.Title], [System.State], [Microsoft.VSTS.Common.Severity]
      FROM WorkItems
      WHERE [System.WorkItemType] = 'Bug'
      AND [System.State] <> 'Closed'
    `;

    if (project) {
      wiql += ` AND [System.TeamProject] = '${project}'`;
    }

    wiql += ' ORDER BY [System.CreatedDate] DESC';

    return await this.queryWorkItems(wiql, project);
  }

  /**
   * 查询近期已解决/已关闭的工作项
   * @param {string} project - 项目名称，null表示所有项目
   * @param {number} days - 最近天数，默认7天
   * @param {string[]} states - 状态列表，默认 ['Resolved', 'Closed']
   */
  async getRecentResolvedWorkItems(project = null, days = 7, states = ['Resolved', 'Closed']) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const startDateStr = formatDateForWIQL(startDate);
    const endDateStr = formatDateForWIQL(endDate);

    // TFS 2018 不支持 System.ClosedDate 和 System.ResolvedDate 字段
    // 使用 System.ChangedDate 进行日期过滤
    let wiql = `
      SELECT [System.Id], [System.Title], [System.WorkItemType],
             [System.State], [System.AssignedTo], [System.CreatedDate],
             [System.ChangedDate],
             [System.Description], [Microsoft.VSTS.Common.Priority],
             [Microsoft.VSTS.Common.Severity], [System.Reason]
      FROM WorkItems
      WHERE [System.State] IN (${states.map(s => `'${s}'`).join(', ')})
      AND [System.ChangedDate] >= '${startDateStr}'
      AND [System.ChangedDate] <= '${endDateStr}'
    `;

    if (project) {
      wiql += ` AND [System.TeamProject] = '${project}'`;
    }

    wiql += ' ORDER BY [System.ChangedDate] DESC';

    return await this.queryWorkItems(wiql, project);
  }

  /**
   * 创建工作项
   */
  async createWorkItem(project, workItemType, fields) {
    const witApi = await this.getWorkItemApi();
    const document = [
      { op: 'add', path: '/fields/System.Title', value: fields.title },
      { op: 'add', path: '/fields/System.Description', value: fields.description || '' }
    ];

    if (fields.assignedTo) {
      document.push({
        op: 'add',
        path: '/fields/System.AssignedTo',
        value: fields.assignedTo
      });
    }

    if (fields.priority !== undefined) {
      document.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Common.Priority',
        value: String(fields.priority)
      });
    }

    if (fields.parentId) {
      document.push({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: `${this.serverUrl}/_apis/wit/workItems/${fields.parentId}`
        }
      });
    }

    return await witApi.createWorkItem(null, document, project, workItemType);
  }

  /**
   * 更新工作项状态
   */
  async updateWorkItemState(id, newState, comment = null) {
    const witApi = await this.getWorkItemApi();
    const document = [
      { op: 'replace', path: '/fields/System.State', value: newState }
    ];

    if (comment) {
      document.push({
        op: 'add',
        path: '/fields/System.History',
        value: comment
      });
    }

    return await witApi.updateWorkItem(null, document, id);
  }

  /**
   * 添加评论
   */
  async addComment(workItemId, comment) {
    const witApi = await this.getWorkItemApi();
    const document = [
      { op: 'add', path: '/fields/System.History', value: comment }
    ];
    return await witApi.updateWorkItem(null, document, workItemId);
  }

  /**
   * 获取项目的 Git 仓库列表
   */
  async getRepositories(project) {
    const gitApi = await this.getGitApi();
    return await gitApi.getRepositories(project);
  }

  /**
   * 获取最近的提交记录
   * @param {string} repositoryId - 仓库ID
   * @param {string} project - 项目名称
   * @param {number} top - 返回记录数，默认20
   * @param {number} days - 最近天数，用于客户端日期过滤，默认null（不过滤）
   */
  async getCommits(repositoryId, project, top = 20, days = null) {
    const gitApi = await this.getGitApi();

    // TFS 2018 API 的日期参数可能不工作，需要先获取提交后在客户端过滤
    const commits = await gitApi.getCommits(
      repositoryId,
      project,
      null,  // branch
      null,  // requestorId
      null,  // itemPath
      top,
      null,  // skip
      null,  // includeLinks
      null,  // fromDate - TFS 2018 可能不支持
      null   // toDate - TFS 2018 可能不支持
    );

    // 如果指定了天数，在客户端进行日期过滤
    if (days) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      return commits.filter(commit => {
        const commitDate = new Date(commit.author?.date || commit.committer?.date);
        return commitDate >= cutoffDate;
      });
    }

    return commits;
  }

  /**
   * 检查提交的工作项关联
   */
  async checkCommitWorkItems(repositoryId, projectId, commitId) {
    const gitApi = await this.getGitApi();
    const commit = await gitApi.getCommit(commitId, repositoryId, projectId);

    const workItems = commit.workItems || [];
    return {
      commitId: commitId,
      hasWorkItems: workItems.length > 0,
      workItemCount: workItems.length,
      workItems: workItems.map(wi => ({
        id: wi.id,
        url: wi.url
      }))
    };
  }

  /**
   * 获取项目 ID
   */
  getProjectId(projectName) {
    return PROJECTS[projectName];
  }

  /**
   * 获取所有项目列表
   */
  getProjects() {
    return { ...PROJECTS };
  }

  /**
   * 检查项目是否存在
   */
  hasProject(projectName) {
    return projectName in PROJECTS;
  }
}

// 导出
export default TFSClient;
export { loadConfig, saveConfig, PROJECTS };
