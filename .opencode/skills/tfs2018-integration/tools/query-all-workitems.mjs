#!/usr/bin/env node
/**
 * 查询所有工作项（不限制状态）
 */

import TFSClient from './tfs-client.mjs';

async function queryAllWorkItems() {
  const client = new TFSClient();

  console.log('查询 WiNEX-Outpatient 项目中最近 10 天的所有工作项...\n');

  // 计算十天前的日期
  const tenDaysAgo = new Date();
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
  const dateStr = tenDaysAgo.toISOString().split('T')[0];

  console.log(`查询日期范围: ${dateStr} 至今\n`);

  // 使用更简单的查询，只获取 ID
  const wiql = `
    SELECT [System.Id]
    FROM WorkItems
    WHERE [System.ChangedDate] > '${dateStr}'
    AND [System.TeamProject] = 'WiNEX-Outpatient'
    ORDER BY [System.ChangedDate] DESC
  `;

  const witApi = await client.getWorkItemApi();
  const queryResult = await witApi.queryByWiql({ query: wiql });

  if (!queryResult.workItems || queryResult.workItems.length === 0) {
    console.log(`未找到 ${dateStr} 之后修改的工作项。`);

    // 尝试查询项目中是否有任何工作项
    console.log('\n尝试查询项目中所有工作项（不限制日期，最多 50 个）...\n');

    const allWiql = `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = 'WiNEX-Outpatient'
      ORDER BY [System.ChangedDate] DESC
    `;

    const allQueryResult = await witApi.queryByWiql({ query: allWiql });

    if (!allQueryResult.workItems || allQueryResult.workItems.length === 0) {
      console.log('项目中没有任何工作项。');
    } else {
      const ids = allQueryResult.workItems.slice(0, 50).map(wi => wi.id);
      console.log(`找到 ${allQueryResult.workItems.length} 个工作项（获取前 50 个详情）...\n`);

      const workItems = await witApi.getWorkItems(ids, null, null, 'All');

      // 按工作项类型分组统计
      const typeCount = {};
      workItems.forEach(wi => {
        const type = wi.fields['System.WorkItemType'] || '未知';
        typeCount[type] = (typeCount[type] || 0) + 1;
      });

      console.log('工作项类型统计:');
      Object.entries(typeCount).forEach(([type, count]) => {
        console.log(`  ${type}: ${count} 个`);
      });
      console.log();

      // 显示详细信息
      workItems.forEach(wi => {
        const id = String(wi.id).padEnd(8);
        const type = (wi.fields['System.WorkItemType'] || '').padEnd(15);
        const state = (wi.fields['System.State'] || '').padEnd(12);
        const title = wi.fields['System.Title'] || '无标题';
        const assignedTo = wi.fields['System.AssignedTo']?.displayName || '未分配';
        const changedDate = new Date(wi.fields['System.ChangedDate']).toLocaleString('zh-CN');

        console.log(`${id} [${type}] [${state}] ${title}`);
        console.log(`    分配给: ${assignedTo}`);
        console.log(`    修改时间: ${changedDate}\n`);
      });
    }
    return;
  }

  // 限制获取前 50 个
  const ids = queryResult.workItems.slice(0, 50).map(wi => wi.id);
  console.log(`找到 ${queryResult.workItems.length} 个工作项（获取前 50 个详情）...\n`);

  const workItems = await witApi.getWorkItems(ids, null, null, 'All');

  // 按工作项类型分组统计
  const typeCount = {};
  workItems.forEach(wi => {
    const type = wi.fields['System.WorkItemType'] || '未知';
    typeCount[type] = (typeCount[type] || 0) + 1;
  });

  console.log('工作项类型统计:');
  Object.entries(typeCount).forEach(([type, count]) => {
    console.log(`  ${type}: ${count} 个`);
  });
  console.log();

  // 显示详细信息
  workItems.forEach(wi => {
    const id = String(wi.id).padEnd(8);
    const type = (wi.fields['System.WorkItemType'] || '').padEnd(15);
    const state = (wi.fields['System.State'] || '').padEnd(12);
    const title = wi.fields['System.Title'] || '无标题';
    const assignedTo = wi.fields['System.AssignedTo']?.displayName || '未分配';
    const changedDate = new Date(wi.fields['System.ChangedDate']).toLocaleString('zh-CN');

    console.log(`${id} [${type}] [${state}] ${title}`);
    console.log(`    分配给: ${assignedTo}`);
    console.log(`    修改时间: ${changedDate}\n`);
  });
}

queryAllWorkItems().catch(error => {
  console.error('查询失败:', error.message);
  process.exit(1);
});
