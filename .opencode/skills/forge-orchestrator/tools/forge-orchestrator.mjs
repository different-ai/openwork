#!/usr/bin/env node
/**
 * Forge Orchestrator - TFS 工作项自动化编排器
 * 
 * 编排完整的 TFS 工作项自动化流程
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TFSClient from '../../tfs2018-integration/tools/tfs-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Forge Orchestrator - 管理工作项自动化生命周期
 */
class ForgeOrchestrator {
  constructor() {
    this.basePath = 'forge/tracks/workitem-autorun';
    this.tfsClient = new TFSClient();
  }

  /**
   * 获取工作项目录路径
   */
  getWorkItemPath(tfsId) {
    return path.join(this.basePath, `tfs-${tfsId}`);
  }

  /**
   * 确保工作项目录存在
   */
  ensureWorkItemDirectory(tfsId) {
    const workItemPath = this.getWorkItemPath(tfsId);
    if (!fs.existsSync(workItemPath)) {
      fs.mkdirSync(workItemPath, { recursive: true });
      console.log(`Created directory: ${workItemPath}`);
    }
    return workItemPath;
  }

  /**
   * 开始处理工作项
   * 1. 获取 TFS 工作项详情
   * 2. 创建 plan.md 和 tasks.md
   * 3. 返回下一步提示
   */
  async start(tfsId) {
    console.log(`Starting automation for TFS work item #${tfsId}...\n`);

    try {
      // Step 1: Get work item details
      console.log('Step 1: Fetching work item details...');
      const workItem = await this.tfsClient.getWorkItem(tfsId);
      
      if (!workItem) {
        throw new Error(`Work item #${tfsId} not found`);
      }

      console.log(`  Title: ${workItem.fields['System.Title']}`);
      console.log(`  State: ${workItem.fields['System.State']}`);
      console.log(`  Type: ${workItem.fields['System.WorkItemType']}`);

      // Step 2: Create directory structure
      console.log('\nStep 2: Creating automation workspace...');
      const workItemPath = this.ensureWorkItemDirectory(tfsId);

      // Step 3: Create plan.md
      console.log('\nStep 3: Generating plan...');
      const planContent = this.generatePlan(workItem);
      const planPath = path.join(workItemPath, 'plan.md');
      fs.writeFileSync(planPath, planContent, 'utf-8');
      console.log(`  Created: ${planPath}`);

      // Step 4: Create tasks.md
      console.log('\nStep 4: Generating tasks...');
      const tasksContent = this.generateTasks(workItem);
      const tasksPath = path.join(workItemPath, 'tasks.md');
      fs.writeFileSync(tasksPath, tasksContent, 'utf-8');
      console.log(`  Created: ${tasksPath}`);

      // Step 5: Create changes directory
      const changesPath = path.join(workItemPath, 'changes');
      if (!fs.existsSync(changesPath)) {
        fs.mkdirSync(changesPath, { recursive: true });
      }

      console.log('\n✓ Automation workspace ready!');
      console.log(`\nNext steps:`);
      console.log(`  1. Review plan: ${planPath}`);
      console.log(`  2. Execute tasks: ${tasksPath}`);
      console.log(`  3. Use: node forge-orchestrator.mjs execute ${tfsId} 0`);

      return {
        success: true,
        workItemPath,
        planPath,
        tasksPath
      };

    } catch (error) {
      console.error(`\n✗ Failed to start automation: ${error.message}`);
      throw error;
    }
  }

  /**
   * 生成计划文档
   */
  generatePlan(workItem) {
    const title = workItem.fields['System.Title'] || 'Untitled';
    const description = workItem.fields['System.Description'] || '';
    const acceptanceCriteria = workItem.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
    const priority = workItem.fields['Microsoft.VSTS.Common.Priority'] || '';

    return `# Plan: ${title}

## Work Item

- **ID**: ${workItem.id}
- **Title**: ${title}
- **Type**: ${workItem.fields['System.WorkItemType']}
- **Priority**: ${priority}
- **State**: ${workItem.fields['System.State']}

## Description

${description}

## Acceptance Criteria

${acceptanceCriteria}

## Approach

<!-- Describe the high-level approach here -->

1. Analyze requirements
2. Design solution
3. Implement changes
4. Test and verify
5. Archive

## Notes

<!-- Add any additional notes here -->
`;
  }

  /**
   * 生成任务列表
   */
  generateTasks(workItem) {
    const title = workItem.fields['System.Title'] || 'Untitled';
    
    return `# Tasks

> **Goal**: ${title}

**Work Item**: #${workItem.id}

---

### Task 1: 分析需求

**状态**: ⏳ 待执行

**描述**: 
分析 TFS 工作项 #${workItem.id} 的需求和上下文。

**步骤**:
1. 读取工作项详情
2. 理解业务需求
3. 识别技术约束
4. 记录分析结果到 plan.md

**输出**:
- plan.md 中的 Approach 章节

---

### Task 2: 设计方案

**状态**: ⏳ 待执行

**描述**: 
基于需求分析，设计技术实现方案。

**步骤**:
1. 确定技术方案
2. 定义接口和数据结构
3. 规划文件组织
4. 更新 plan.md

**输出**:
- plan.md 中的设计文档

---

### Task 3: 实现方案

**状态**: ⏳ 待执行

**描述**: 
按照设计方案实现代码变更。

**步骤**:
1. 创建/修改文件
2. 编写代码
3. 添加测试
4. 运行验证

**输出**:
- changes/ 目录中的变更文件

---

### Task 4: 验证和归档

**状态**: ⏳ 待执行

**描述**: 
验证实现是否符合需求，然后归档。

**步骤**:
1. 对照 Acceptance Criteria 检查
2. 运行测试
3. 更新 TFS 状态为"已解决"
4. 执行 forge-archive

**输出**:
- ARCHIVE.md
- TFS 状态更新
`;
  }

  /**
   * 执行指定任务
   */
  async execute(tfsId, taskIndex) {
    console.log(`Executing task ${taskIndex} for work item #${tfsId}...\n`);

    const tasksPath = path.join(this.getWorkItemPath(tfsId), 'tasks.md');
    
    if (!fs.existsSync(tasksPath)) {
      throw new Error(`Tasks file not found: ${tasksPath}`);
    }

    // Update task status to in-progress
    const content = fs.readFileSync(tasksPath, 'utf-8');
    const updated = this.updateTaskStatus(content, taskIndex, '🔄 执行中');
    fs.writeFileSync(tasksPath, updated, 'utf-8');

    console.log(`✓ Task ${taskIndex} marked as in-progress`);
    console.log(`\nNext: Complete the task and run:`);
    console.log(`  node forge-orchestrator.mjs complete ${tfsId} ${taskIndex}`);

    return { success: true, taskIndex, status: 'in-progress' };
  }

  /**
   * 标记任务完成
   */
  async complete(tfsId, taskIndex) {
    console.log(`Completing task ${taskIndex} for work item #${tfsId}...\n`);

    const tasksPath = path.join(this.getWorkItemPath(tfsId), 'tasks.md');
    
    if (!fs.existsSync(tasksPath)) {
      throw new Error(`Tasks file not found: ${tasksPath}`);
    }

    // Update task status to completed
    const content = fs.readFileSync(tasksPath, 'utf-8');
    const updated = this.updateTaskStatus(content, taskIndex, '✅ 已完成');
    fs.writeFileSync(tasksPath, updated, 'utf-8');

    console.log(`✓ Task ${taskIndex} marked as completed`);

    // Check if all tasks are completed
    const tasks = this.parseTasks(updated);
    const allCompleted = tasks.every(t => t.status === '✅ 已完成');

    if (allCompleted) {
      console.log('\n🎉 All tasks completed! Ready to archive.');
      console.log(`Run: node forge-orchestrator.mjs archive ${tfsId}`);
    } else {
      const nextTask = tasks.find(t => t.status === '⏳ 待执行');
      if (nextTask) {
        console.log(`\nNext: Execute task ${nextTask.index}`);
        console.log(`  node forge-orchestrator.mjs execute ${tfsId} ${nextTask.index}`);
      }
    }

    return { success: true, taskIndex, status: 'completed', allCompleted };
  }

  /**
   * 归档工作项
   * 1. 执行 forge-archive
   * 2. 更新 TFS 状态为"已解决"
   */
  async archive(tfsId) {
    console.log(`Archiving work item #${tfsId}...\n`);

    try {
      // Step 1: Update TFS state to "已解决"
      console.log('Step 1: Updating TFS state to 已解决...');
      await this.tfsClient.updateWorkItemState(tfsId, '已解决', 
        `任务已完成，通过 Task Center 自动化流程归档`);
      console.log('  ✓ TFS state updated to 已解决');

      // Step 2: Run forge-archive
      console.log('\nStep 2: Running forge-archive...');
      const { execSync } = await import('child_process');
      const workItemPath = this.getWorkItemPath(tfsId);
      
      try {
        execSync('npx opencode skill forge-archive', { 
          cwd: workItemPath,
          stdio: 'inherit'
        });
        console.log('  ✓ Archive completed');
      } catch (err) {
        console.warn('  ⚠ Archive command failed, manual archive may be needed');
      }

      console.log('\n✓ Work item archived successfully!');
      return { success: true };

    } catch (error) {
      console.error(`\n✗ Archive failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * 解析任务列表
   */
  parseTasks(content) {
    const tasks = [];
    const lines = content.split('\n');
    let currentTask = null;

    for (const line of lines) {
      const taskMatch = line.match(/^### Task (\d+):\s*(.+)$/);
      if (taskMatch) {
        currentTask = {
          index: parseInt(taskMatch[1]) - 1,
          title: taskMatch[2],
          status: '⏳ 待执行'
        };
      }

      const statusMatch = line.match(/\*\*状态\*\*:\s*(.+)/);
      if (statusMatch && currentTask) {
        currentTask.status = statusMatch[1].trim();
        tasks.push(currentTask);
        currentTask = null;
      }
    }

    return tasks;
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(content, taskIndex, newStatus) {
    const lines = content.split('\n');
    let currentTaskIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const taskMatch = lines[i].match(/^### Task (\d+):/);
      if (taskMatch) {
        currentTaskIndex = parseInt(taskMatch[1]) - 1;
      }

      if (currentTaskIndex === taskIndex && lines[i].includes('**状态**')) {
        lines[i] = `**状态**: ${newStatus}`;
        break;
      }
    }

    return lines.join('\n');
  }
}

/**
 * 命令行接口
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const tfsId = parseInt(args[1]);

  if (!command || !tfsId) {
    console.log('Forge Orchestrator - TFS Work Item Automation\n');
    console.log('Usage: forge-orchestrator <command> <tfs-id> [options]\n');
    console.log('Commands:');
    console.log('  start <tfs-id>              Start automation for work item');
    console.log('  execute <tfs-id> <index>    Execute specific task');
    console.log('  complete <tfs-id> <index>   Mark task as completed');
    console.log('  archive <tfs-id>            Archive completed work item');
    console.log('\nExamples:');
    console.log('  node forge-orchestrator.mjs start 12345');
    console.log('  node forge-orchestrator.mjs execute 12345 0');
    console.log('  node forge-orchestrator.mjs complete 12345 0');
    console.log('  node forge-orchestrator.mjs archive 12345');
    process.exit(1);
  }

  const orchestrator = new ForgeOrchestrator();

  try {
    switch (command) {
      case 'start':
        await orchestrator.start(tfsId);
        break;

      case 'execute': {
        const executeIndex = parseInt(args[2]);
        if (isNaN(executeIndex)) {
          console.error('Error: Task index required');
          process.exit(1);
        }
        await orchestrator.execute(tfsId, executeIndex);
        break;
      }

      case 'complete': {
        const completeIndex = parseInt(args[2]);
        if (isNaN(completeIndex)) {
          console.error('Error: Task index required');
          process.exit(1);
        }
        await orchestrator.complete(tfsId, completeIndex);
        break;
      }

      case 'archive':
        await orchestrator.archive(tfsId);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
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
export { ForgeOrchestrator };
export default ForgeOrchestrator;
