#!/usr/bin/env node
/**
 * 测试 - 使用中文状态名查询
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import azureDevOps from 'azure-devops-node-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载配置
const configPath = path.join(__dirname, '..', 'config', 'tfs-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const authHandler = azureDevOps.getPersonalAccessTokenHandler(config.pat);
const connection = new azureDevOps.WebApi(config.serverUrl, authHandler);

async function test() {
  console.log('=== Test Chinese State Names ===\n');
  
  try {
    const witApi = await connection.getWorkItemTrackingApi();
    
    // 测试 1: 使用中文状态名 "活动" (Active)
    console.log('Test 1: Query with Chinese state "活动" (Active)');
    const wiql1 = `
      SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
      FROM WorkItems
      WHERE [System.AssignedTo] = @me
      AND [System.State] = '活动'
      AND [System.TeamProject] = 'WiNEX-Outpatient'
    `;
    
    const result1 = await witApi.queryByWiql({ query: wiql1 });
    console.log(`Result: ${result1.workItems?.length || 0} work items\n`);
    
    // 测试 2: 使用中文状态名 "已建议" (Proposed)
    console.log('Test 2: Query with Chinese state "已建议" (Proposed/Suggested)');
    const wiql2 = `
      SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
      FROM WorkItems
      WHERE [System.AssignedTo] = @me
      AND [System.State] = '已建议'
      AND [System.TeamProject] = 'WiNEX-Outpatient'
    `;
    
    const result2 = await witApi.queryByWiql({ query: wiql2 });
    console.log(`Result: ${result2.workItems?.length || 0} work items\n`);
    
    // 测试 3: 使用中文状态名多个状态
    console.log('Test 3: Query with Chinese states "活动" OR "已建议"');
    const wiql3 = `
      SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
      FROM WorkItems
      WHERE [System.AssignedTo] = @me
      AND [System.State] IN ('活动', '已建议')
      AND [System.TeamProject] = 'WiNEX-Outpatient'
    `;
    
    const result3 = await witApi.queryByWiql({ query: wiql3 });
    console.log(`Result: ${result3.workItems?.length || 0} work items`);
    
    if (result3.workItems && result3.workItems.length > 0) {
      console.log('\nWork items found:');
      const ids = result3.workItems.map(wi => wi.id).slice(0, 5);
      const details = await witApi.getWorkItems(ids, null, null, 'All');
      
      details.forEach(wi => {
        console.log(`  #${wi.id}: ${wi.fields['System.Title']}`);
        console.log(`     State: ${wi.fields['System.State']}`);
      });
    }
    
    console.log('\n\n=== Summary ===');
    console.log('TFS 2018 使用的是中文状态名:');
    console.log('  - "已建议" = Proposed/Suggested/New');
    console.log('  - "活动"   = Active');
    console.log('  - "已解决" = Resolved');
    console.log('  - "已关闭" = Closed');
    console.log('\n查询时需要用中文状态名，而不是英文的 New/Active/Resolved/Closed');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();
