#!/usr/bin/env node
/**
 * 查询最近两天的任务
 */

import TFSClient from './tfs-client.mjs';

async function queryRecentTasks() {
  const client = new TFSClient();

  // 计算两天前的日期 (格式: YYYY-MM-DD)
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const dateStr = twoDaysAgo.toISOString().split('T')[0];

  // WIQL 查询最近两天修改或创建的任务
  const wiql = `
    SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo],
           [System.CreatedDate], [System.ChangedDate], [System.WorkItemType]
    FROM WorkItems
    WHERE [System.WorkItemType] = 'Task'
    AND ([System.CreatedDate] > '${dateStr}' OR [System.ChangedDate] > '${dateStr}')
    AND [System.TeamProject] = 'WiNEX-Outpatient'
    ORDER BY [System.ChangedDate] DESC
  `;

  console.log(`查询 WiNEX-Outpatient 项目中最近两天的任务...\n`);

  const workItems = await client.queryWorkItems(wiql);

  if (workItems.length === 0) {
    console.log('未找到最近两天的任务。');
    return;
  }

  console.log(`找到 ${workItems.length} 个任务:\n`);

  workItems.forEach(wi => {
    const id = String(wi.id).padEnd(8);
    const state = (wi.fields['System.State'] || '未知').padEnd(10);
    const title = wi.fields['System.Title'] || '无标题';
    const assignedTo = wi.fields['System.AssignedTo']?.displayName || '未分配';
    const createdDate = new Date(wi.fields['System.CreatedDate']).toLocaleString('zh-CN');
    const changedDate = new Date(wi.fields['System.ChangedDate']).toLocaleString('zh-CN');

    console.log(`${id} [${state}] ${title}`);
    console.log(`    分配给: ${assignedTo}`);
    console.log(`    创建时间: ${createdDate}`);
    console.log(`    修改时间: ${changedDate}`);
    console.log();
  });
}

queryRecentTasks().catch(error => {
  console.error('查询失败:', error.message);
  process.exit(1);
});
