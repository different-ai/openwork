#!/usr/bin/env node
/**
 * 测试 TFS 查询 - 扩大查询范围
 */

import TaskCenterTFSClient from './task-center-integration.mjs';

async function test() {
  const client = new TaskCenterTFSClient();
  
  console.log('=== TFS Query Test (Extended) ===\n');
  
  // 测试 1: 查询所有项目，不限制天数
  console.log('Test 1: Query all project work items (no date limit)');
  console.log('Project: WiNEX-Outpatient');
  try {
    const allItems = await client.getAllProjectWorkItems('WiNEX-Outpatient', {
      states: ['New', 'Active', 'Resolved', 'Closed'],
      days: null,  // 不限制天数
      top: 20
    });
    console.log(`Result: ${allItems.length} work item(s)\n`);
    
    if (allItems.length > 0) {
      allItems.forEach(t => {
        console.log(`  #${t.id}: ${t.title}`);
        console.log(`     Type: ${t.workItemType} | State: ${t.state}`);
        console.log(`     Assigned: ${t.assignedTo}`);
        console.log();
      });
    } else {
      console.log('No work items found in WiNEX-Outpatient.\n');
    }
  } catch (e) {
    console.error(`Error: ${e.message}\n`);
  }
  
  // 测试 2: 尝试其他项目
  console.log('Test 2: Try other projects');
  const testProjects = ['OA4.0', 'WiNEX-Copilot', 'WiNEX-Integration'];
  
  for (const project of testProjects) {
    try {
      const items = await client.getAllProjectWorkItems(project, {
        states: ['New', 'Active'],
        days: 30,
        top: 5
      });
      console.log(`  ${project}: ${items.length} items`);
    } catch (e) {
      console.log(`  ${project}: Error - ${e.message}`);
    }
  }
  
  // 测试 3: 查询最近修改的所有工作项
  console.log('\nTest 3: Query recent work items from all projects');
  try {
    const allMyItems = await client.getMyWorkItems({
      project: null,  // 所有项目
      states: ['New', 'Active', 'Resolved'],
      days: 30,
      top: 10
    });
    console.log(`Found ${allMyItems.length} work item(s) assigned to me\n`);
    
    if (allMyItems.length > 0) {
      allMyItems.forEach(t => {
        console.log(`  #${t.id}: ${t.title} (${t.project})`);
      });
    }
  } catch (e) {
    console.error(`Error: ${e.message}\n`);
  }
  
  console.log('\n=== Troubleshooting ===');
  console.log('If you created a work item but cannot see it:');
  console.log('1. Check if the work item is in project WiNEX-Outpatient');
  console.log('2. Check if the work item is assigned to your TFS account');
  console.log('3. The work item might be in a different state (e.g., Proposed)');
  console.log('4. Wait a few minutes for TFS to index the new work item');
  console.log('\nTry visiting the work item in TFS web:');
  console.log('  http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0/_workitems');
}

test().catch(console.error);
