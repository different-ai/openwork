#!/usr/bin/env node
/**
 * Task Center Integration - TFS 任务控制中心集成工具
 * 
 * 为任务控制中心看板提供完整的 TFS 工作项管理能力
 * 包括：获取工作项、更新状态、关联 PR、批量操作等
 * 
 * 卫宁健康 WINNING-6.0 团队
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TFSClient from './tfs-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 任务控制中心专用 TFS 客户端扩展
 */
class TaskCenterTFSClient extends TFSClient {
  constructor() {
    super();
  }

  /**
   * 获取我的工作项列表（支持状态过滤和分页）
   * 
   * 注意：TFS 2018 使用中文状态名
   * - "已建议" = New/Proposed
   * - "已分析" = Analyzed
   * - "活动" = Active
   * - "已解决" = Resolved
   * - "已关闭" = Closed
   * 
   * @param {Object} options - 查询选项
   * @param {string} options.project - 项目名称，null表示所有项目（默认）
   * @param {string[]} options.states - 中文状态列表，如 ['已建议', '活动', '已解决']
   * @param {string[]} options.workItemTypes - 工作项类型，如 ['Task', 'Bug', 'User Story']
   * @param {number} options.days - 最近修改天数，null表示不限制
   * @param {number} options.top - 返回数量限制，默认 100
   * @returns {Promise<Array>} 工作项列表
   */
  async getMyWorkItems(options = {}) {
    const {
      project = null,
      states = ['已建议', '已分析'],
      workItemTypes = ['Task', 'Bug', 'User Story', '需求'],
      days = null,
      top = 100
    } = options;

    // 构建 WIQL 查询
    let wiql = `
      SELECT [System.Id], [System.Title], [System.State], 
             [System.AssignedTo], [System.WorkItemType], 
             [System.CreatedDate], [System.ChangedDate],
             [System.Description], [Microsoft.VSTS.Common.Priority],
             [System.Tags], [Microsoft.VSTS.Common.AcceptanceCriteria],
             [System.AreaPath], [System.IterationPath]
      FROM WorkItems
      WHERE ${this.getAssignedToClause()}
      AND [System.State] IN (${states.map(s => `'${s}'`).join(', ')})
      AND [System.WorkItemType] IN (${workItemTypes.map(t => `'${t}'`).join(', ')})
    `;

    // 添加项目过滤（默认不限制，查询所有项目）
    if (project) {
      wiql += ` AND [System.TeamProject] = '${project}'`;
    }

    // 添加日期过滤
    if (days) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      const dateStr = this.formatDateForWIQL(cutoffDate);
      wiql += ` AND [System.ChangedDate] >= '${dateStr}'`;
    }

    wiql += ' ORDER BY [Microsoft.VSTS.Common.Priority], [System.ChangedDate] DESC';

    const workItems = await this.queryWorkItems(wiql, project);
    
    // 格式化输出
    return workItems.slice(0, top).map(wi => this.formatWorkItemForTaskCenter(wi));
  }

  /**
   * 获取工作项详情（完整信息）
   * 
   * @param {number} id - 工作项 ID
   * @param {string} project - 项目名称（可选）
   * @returns {Promise<Object>} 格式化后的工作项详情
   */
  async getWorkItemDetail(id, project = null) {
    const witApi = await this.getWorkItemApi();
    const workItem = await witApi.getWorkItem(id, null, null, 'All', project);
    
    return this.formatWorkItemForTaskCenter(workItem, true);
  }

  /**
   * 批量获取工作项详情
   * 
   * @param {number[]} ids - 工作项 ID 数组
   * @param {string} project - 项目名称（可选）
   * @returns {Promise<Array>} 工作项详情列表
   */
  async getWorkItemsDetails(ids, project = null) {
    if (!ids || ids.length === 0) {
      return [];
    }

    const witApi = await this.getWorkItemApi();
    const workItems = await witApi.getWorkItems(ids, null, null, 'All', null, project);
    
    return workItems.map(wi => this.formatWorkItemForTaskCenter(wi, true));
  }

  /**
   * 更新工作项状态（支持添加评论和关联 PR）
   * 
   * @param {number} id - 工作项 ID
   * @param {string} newState - 新状态
   * @param {Object} options - 选项
   * @param {string} options.comment - 评论内容
   * @param {string} options.prUrl - PR 链接
   * @param {string} options.prTitle - PR 标题
   * @returns {Promise<Object>} 更新后的工作项
   */
  async updateWorkItemStateWithContext(id, newState, options = {}) {
    const { comment = null, prUrl = null, prTitle = null } = options;
    
    const witApi = await this.getWorkItemApi();
    const document = [
      { op: 'replace', path: '/fields/System.State', value: newState }
    ];

    // 添加评论
    if (comment) {
      document.push({
        op: 'add',
        path: '/fields/System.History',
        value: comment
      });
    }

    // 关联 PR
    if (prUrl) {
      const linkText = prTitle ? `Pull Request: ${prTitle}` : 'Pull Request';
      document.push({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'ArtifactLink',
          url: prUrl,
          attributes: {
            name: linkText
          }
        }
      });
    }

    const result = await witApi.updateWorkItem(null, document, id);
    return this.formatWorkItemForTaskCenter(result);
  }

  /**
   * 将工作项标记为进行中（Active）
   * 
   * @param {number} id - 工作项 ID
   * @param {string} comment - 可选评论
   * @returns {Promise<Object>} 更新后的工作项
   */
  async activateWorkItem(id, comment = null) {
    const defaultComment = comment || '任务已开始处理 (via Task Center)';
    return await this.updateWorkItemStateWithContext(id, 'Active', {
      comment: defaultComment
    });
  }

  /**
   * 将工作项标记为已解决（Resolved）
   * 
   * @param {number} id - 工作项 ID
   * @param {Object} options - 选项
   * @param {string} options.comment - 评论
   * @param {string} options.prUrl - PR 链接
   * @param {string} options.prTitle - PR 标题
   * @returns {Promise<Object>} 更新后的工作项
   */
  async resolveWorkItem(id, options = {}) {
    const { comment = null, prUrl = null, prTitle = null } = options;
    const defaultComment = comment || '任务已完成，代码已提交 (via Task Center)';
    
    return await this.updateWorkItemStateWithContext(id, 'Resolved', {
      comment: defaultComment,
      prUrl,
      prTitle
    });
  }

  /**
   * 将工作项标记为已关闭（Closed）
   * 
   * @param {number} id - 工作项 ID
   * @param {string} comment - 可选评论
   * @returns {Promise<Object>} 更新后的工作项
   */
  async closeWorkItem(id, comment = null) {
    const defaultComment = comment || '任务已验证通过并关闭 (via Task Center)';
    return await this.updateWorkItemStateWithContext(id, 'Closed', {
      comment: defaultComment
    });
  }

  /**
   * 获取工作项的历史记录
   * 
   * @param {number} id - 工作项 ID
   * @returns {Promise<Array>} 历史记录列表
   */
  async getWorkItemHistory(id) {
    const witApi = await this.getWorkItemApi();
    const updates = await witApi.getUpdates(id);
    
    return updates.map(update => ({
      id: update.id,
      rev: update.rev,
      revisedBy: update.revisedBy?.displayName || 'Unknown',
      revisedDate: update.revisedDate,
      fields: update.fields || {}
    }));
  }

  /**
   * 查询与代码提交关联的工作项
   * 
   * @param {string} repositoryId - 仓库 ID
   * @param {string} project - 项目名称
   * @param {number} days - 最近天数
   * @returns {Promise<Array>} 关联的工作项列表
   */
  async getWorkItemsLinkedToCommits(repositoryId, project, days = 7) {
    const gitApi = await this.getGitApi();
    
    // 获取最近的提交
    const commits = await this.getCommits(repositoryId, project, 100, days);
    
    // 收集所有关联的工作项 ID
    const workItemIds = new Set();
    const commitWorkItemMap = new Map();
    
    for (const commit of commits) {
      const workItems = commit.workItems || [];
      if (workItems.length > 0) {
        commitWorkItemMap.set(commit.commitId, {
          commitId: commit.commitId.slice(0, 8),
          comment: commit.comment,
          workItems: workItems.map(wi => wi.id)
        });
        
        workItems.forEach(wi => workItemIds.add(wi.id));
      }
    }
    
    // 获取工作项详情
    const workItemDetails = [];
    if (workItemIds.size > 0) {
      const ids = Array.from(workItemIds);
      const items = await this.getWorkItemsDetails(ids, project);
      workItemDetails.push(...items);
    }
    
    return {
      commits: Array.from(commitWorkItemMap.values()),
      workItems: workItemDetails
    };
  }

  /**
   * 获取项目的所有工作项（用于管理员）
   * 
   * @param {string} project - 项目名称
   * @param {Object} options - 查询选项
   * @returns {Promise<Array>} 工作项列表
   */
  async getAllProjectWorkItems(project, options = {}) {
    const {
      states = ['New', 'Active', 'Resolved'],
      days = 30,
      top = 200
    } = options;

    let wiql = `
      SELECT [System.Id], [System.Title], [System.State], 
             [System.AssignedTo], [System.WorkItemType], 
             [System.CreatedDate], [System.ChangedDate],
             [System.Description], [Microsoft.VSTS.Common.Priority]
      FROM WorkItems
      WHERE [System.State] IN (${states.map(s => `'${s}'`).join(', ')})
      AND [System.TeamProject] = '${project}'
    `;

    if (days) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      const dateStr = this.formatDateForWIQL(cutoffDate);
      wiql += ` AND [System.ChangedDate] >= '${dateStr}'`;
    }

    wiql += ' ORDER BY [System.ChangedDate] DESC';

    const workItems = await this.queryWorkItems(wiql, project);
    return workItems.slice(0, top).map(wi => this.formatWorkItemForTaskCenter(wi));
  }

  /**
   * 格式化日期为 WIQL 格式
   * @private
   */
  formatDateForWIQL(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * 格式化工作项为任务控制中心标准格式
   * @private
   */
  formatWorkItemForTaskCenter(workItem, includeDetails = false) {
    if (!workItem) return null;

    const fields = workItem.fields || {};
    
    const projectName = fields['System.TeamProject'] || '';
    const projectSegment = projectName ? `/${encodeURIComponent(projectName)}` : '';
    const browserUrl = `${this.serverUrl}${projectSegment}/_workitems?id=${workItem.id}`;

    const formatted = {
      id: workItem.id,
      title: fields['System.Title'] || 'No Title',
      description: fields['System.Description'] || '',
      state: fields['System.State'] || 'Unknown',
      workItemType: fields['System.WorkItemType'] || 'Unknown',
      assignedTo: this.extractUserName(fields['System.AssignedTo']),
      priority: parseInt(fields['Microsoft.VSTS.Common.Priority']) || 0,
      project: fields['System.TeamProject'] || 'Unknown',
      createdDate: fields['System.CreatedDate'],
      changedDate: fields['System.ChangedDate'],
      tags: this.parseTags(fields['System.Tags']),
      url: browserUrl
    };

    // 详细信息
    if (includeDetails) {
      formatted.acceptanceCriteria = fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
      formatted.areaPath = fields['System.AreaPath'] || '';
      formatted.iterationPath = fields['System.IterationPath'] || '';
      formatted.reason = fields['System.Reason'] || '';
      formatted.createdBy = this.extractUserName(fields['System.CreatedBy']);
      formatted.changedBy = this.extractUserName(fields['System.ChangedBy']);
    }

    return formatted;
  }

  /**
   * 从用户字段提取用户名
   * @private
   */
  extractUserName(userField) {
    if (!userField) return 'Unassigned';
    if (typeof userField === 'string') return userField;
    return userField.displayName || userField.uniqueName || 'Unknown';
  }

  /**
   * 解析标签字符串
   * @private
   */
  parseTags(tagsField) {
    if (!tagsField) return [];
    if (typeof tagsField === 'string') {
      return tagsField.split(';').map(t => t.trim()).filter(Boolean);
    }
    return [];
  }
}

/**
 * 命令行接口
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const client = new TaskCenterTFSClient();

  try {
    switch (command) {
      case 'my-tasks':
      case 'list':
      case 'list-json': {
        const project = args[1] || null;
        const statesArg = args[2] || '已建议,已分析';
        const states = statesArg.split(',');

        const tasks = await client.getMyWorkItems({
          project,
          states,
          top: 200
        });

        if (command === 'list-json') {
          console.log(JSON.stringify(tasks, null, 2));
          break;
        }

        console.log(`Fetching my tasks${project ? ` from ${project}` : ' from all projects'}...\n`);
        console.log(`States: ${states.join(', ')}\n`);

        if (tasks.length === 0) {
          console.log('No tasks found.');
          console.log('\nTips:');
          console.log('  • 查询分配给当前用户（@me）的工作项');
          console.log('  • 确保工作项分配给了正确的账号');
          console.log('  • 查询所有项目: node task-center-integration.mjs list');
          console.log('  • 查询特定项目: node task-center-integration.mjs list WiNEX-Outpatient');
          break;
        }

        console.log(`Found ${tasks.length} task(s):\n`);
        
        // 按状态分组
        const grouped = tasks.reduce((acc, task) => {
          acc[task.state] = acc[task.state] || [];
          acc[task.state].push(task);
          return acc;
        }, {});

        for (const [state, items] of Object.entries(grouped)) {
          console.log(`\n[${state}] (${items.length})`);
          console.log('-'.repeat(60));
          items.forEach(task => {
            const id = String(task.id).padEnd(8);
            const priority = `P${task.priority}`.padEnd(3);
            const type = task.workItemType.padEnd(12);
            const project = task.project ? task.project.padEnd(18) : 'No Project'.padEnd(18);
            console.log(`  #${id} [${priority}] [${type}] [${project}] ${task.title}`);
          });
        }
        
        console.log('\n---');
        console.log(`Total: ${tasks.length} tasks`);
        break;
      }

      case 'detail':
      case 'show': {
        const id = parseInt(args[1]);
        if (!id) {
          console.error('Usage: task-center-integration show <work-item-id>');
          process.exit(1);
        }

        console.log(`Fetching details for work item #${id}...\n`);
        
        const detail = await client.getWorkItemDetail(id);
        
        console.log(`ID:          #${detail.id}`);
        console.log(`Title:       ${detail.title}`);
        console.log(`Type:        ${detail.workItemType}`);
        console.log(`State:       ${detail.state}`);
        console.log(`Priority:    P${detail.priority}`);
        console.log(`Assigned To: ${detail.assignedTo}`);
        console.log(`Project:     ${detail.project}`);
        console.log(`Created:     ${new Date(detail.createdDate).toLocaleString()}`);
        console.log(`Modified:    ${new Date(detail.changedDate).toLocaleString()}`);
        console.log(`URL:         ${detail.url}`);
        
        if (detail.tags.length > 0) {
          console.log(`Tags:        ${detail.tags.join(', ')}`);
        }
        
        console.log(`\nDescription:`);
        console.log(detail.description || '(No description)');
        
        if (detail.acceptanceCriteria) {
          console.log(`\nAcceptance Criteria:`);
          console.log(detail.acceptanceCriteria);
        }
        break;
      }

      case 'activate': {
        const id = parseInt(args[1]);
        if (!id) {
          console.error('Usage: task-center-integration activate <work-item-id>');
          process.exit(1);
        }

        console.log(`Activating work item #${id}...`);
        
        const result = await client.activateWorkItem(id);
        console.log(`✓ Work item #${result.id} activated successfully.`);
        console.log(`  New state: ${result.state}`);
        break;
      }

      case 'resolve': {
        const id = parseInt(args[1]);
        const prUrl = args[2];
        
        if (!id) {
          console.error('Usage: task-center-integration resolve <work-item-id> [pr-url]');
          process.exit(1);
        }

        console.log(`Resolving work item #${id}...`);
        
        const result = await client.resolveWorkItem(id, {
          prUrl: prUrl || null
        });
        
        console.log(`✓ Work item #${result.id} resolved successfully.`);
        console.log(`  New state: ${result.state}`);
        if (prUrl) {
          console.log(`  Linked PR: ${prUrl}`);
        }
        break;
      }

      case 'close': {
        const id = parseInt(args[1]);
        if (!id) {
          console.error('Usage: task-center-integration close <work-item-id>');
          process.exit(1);
        }

        console.log(`Closing work item #${id}...`);
        
        const result = await client.closeWorkItem(id);
        console.log(`✓ Work item #${result.id} closed successfully.`);
        console.log(`  New state: ${result.state}`);
        break;
      }

      case 'history': {
        const id = parseInt(args[1]);
        if (!id) {
          console.error('Usage: task-center-integration history <work-item-id>');
          process.exit(1);
        }

        console.log(`Fetching history for work item #${id}...\n`);
        
        const history = await client.getWorkItemHistory(id);
        
        if (history.length === 0) {
          console.log('No history found.');
          break;
        }

        console.log(`Found ${history.length} update(s):\n`);
        
        history.forEach((update, index) => {
          console.log(`[${index + 1}] ${new Date(update.revisedDate).toLocaleString()}`);
          console.log(`    By: ${update.revisedBy}`);
          
          const fields = Object.keys(update.fields);
          if (fields.length > 0) {
            console.log(`    Changed: ${fields.join(', ')}`);
          }
          console.log();
        });
        break;
      }

      case 'linked-commits': {
        const project = args[1];
        const repoId = args[2];
        const days = parseInt(args[3]) || 7;
        
        if (!project || !repoId) {
          console.error('Usage: task-center-integration linked-commits <project> <repo-id> [days]');
          process.exit(1);
        }

        console.log(`Fetching commits linked to work items in ${project}...\n`);
        
        const result = await client.getWorkItemsLinkedToCommits(repoId, project, days);
        
        console.log(`Found ${result.commits.length} commit(s) with work item links:`);
        console.log(`Found ${result.workItems.length} unique work item(s)\n`);
        
        result.commits.forEach(commit => {
          console.log(`Commit ${commit.commitId}: ${commit.comment.slice(0, 50)}...`);
          console.log(`  Linked work items: ${commit.workItems.join(', ')}`);
        });
        break;
      }

      default:
        console.log('Task Center TFS Integration Tool\n');
        console.log('Usage: task-center-integration <command> [options]\n');
        console.log('Commands:');
        console.log('  list [project] [states]     List my tasks (default: New,Active)');
        console.log('  show <id>                   Show work item details');
        console.log('  activate <id>               Activate (set to Active)');
        console.log('  resolve <id> [pr-url]       Resolve (set to Resolved)');
        console.log('  close <id>                  Close (set to Closed)');
        console.log('  history <id>                Show work item history');
        console.log('  linked-commits <p> <r> [d]  Show commits linked to work items');
        console.log('\nExamples:');
        console.log('  task-center-integration list WiNEX-Outpatient');
        console.log('  task-center-integration list WiNEX-Outpatient New,Active,Resolved');
        console.log('  task-center-integration show 12345');
        console.log('  task-center-integration activate 12345');
        console.log('  task-center-integration resolve 12345 https://tfs/.../pullrequest/1');
        break;
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// 如果直接运行此文件
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

// 导出类供其他模块使用
export { TaskCenterTFSClient };
export default TaskCenterTFSClient;
