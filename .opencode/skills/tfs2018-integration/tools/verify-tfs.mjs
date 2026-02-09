#!/usr/bin/env node
/**
 * 验证 TFS 连接并查询任务
 */

import TFSClient from './tfs-client.mjs';

async function verifyAndQuery() {
  const client = new TFSClient();

  console.log('正在验证 TFS 连接...\n');

  // 1. 先测试连接 - 查询所有项目中的活动任务（限制数量）
  console.log('1. 测试连接 - 查询 WiNEX-Outpatient 项目中的所有活动任务（最多 10 个）:\n');

  const testWiql = `
    SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo],
           [System.CreatedDate], [System.ChangedDate]
    FROM WorkItems
    WHERE [System.WorkItemType] = 'Task'
    AND [System.State] <> 'Closed'
    AND [System.TeamProject] = 'WiNEX-Outpatient'
    ORDER BY [System.ChangedDate] DESC
  `;

  const testWorkItems = await client.queryWorkItems(testWiql);

  if (testWorkItems.length === 0) {
    console.log('  未找到任何活动任务。\n');
  } else {
    console.log(`  找到 ${testWorkItems.length} 个活动任务（显示最近 10 个）:\n`);
    testWorkItems.slice(0, 10).forEach(wi => {
      const id = String(wi.id).padEnd(8);
      const state = (wi.fields['System.State'] || '未知').padEnd(10);
      const title = wi.fields['System.Title'] || '无标题';
      const changedDate = new Date(wi.fields['System.ChangedDate']).toLocaleString('zh-CN');

      console.log(`  ${id} [${state}] ${title}`);
      console.log(`      修改时间: ${changedDate}\n`);
    });
  }

  // 2. 查询最近一周的任务
  console.log('2. 查询最近一周修改的任务:\n');

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const dateStr = oneWeekAgo.toISOString().split('T')[0];

  const recentWiql = `
    SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo],
           [System.ChangedDate]
    FROM WorkItems
    WHERE [System.WorkItemType] = 'Task'
    AND [System.ChangedDate] > '${dateStr}'
    AND [System.TeamProject] = 'WiNEX-Outpatient'
    ORDER BY [System.ChangedDate] DESC
  `;

  const recentWorkItems = await client.queryWorkItems(recentWiql);

  if (recentWorkItems.length === 0) {
    console.log(`  未找到 ${dateStr} 之后修改的任务。\n`);
  } else {
    console.log(`  找到 ${recentWorkItems.length} 个最近一周修改的任务:\n`);
    recentWorkItems.forEach(wi => {
      const id = String(wi.id).padEnd(8);
      const state = (wi.fields['System.State'] || '未知').padEnd(10);
      const title = wi.fields['System.Title'] || '无标题';
      const assignedTo = wi.fields['System.AssignedTo']?.displayName || '未分配';
      const changedDate = new Date(wi.fields['System.ChangedDate']).toLocaleString('zh-CN');

      console.log(`  ${id} [${state}] ${title}`);
      console.log(`      分配给: ${assignedTo}`);
      console.log(`      修改时间: ${changedDate}\n`);
    });
  }

  // 3. 检查当前项目是否存在
  console.log('3. 验证项目信息:\n');
  const projects = client.getProjects();
  const projectExists = client.hasProject('WiNEX-Outpatient');
  console.log(`  WiNEX-Outpatient 项目存在: ${projectExists ? '是' : '否'}`);
  if (projectExists) {
    console.log(`  项目 ID: ${projects['WiNEX-Outpatient']}\n`);
  }
}

verifyAndQuery().catch(error => {
  console.error('查询失败:', error.message);
  process.exit(1);
});
