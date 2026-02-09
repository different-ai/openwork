#!/usr/bin/env node
/**
 * 测试通过 @me 查询和直接查询
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
  console.log('=== TFS Query Test with @me ===\n');
  
  try {
    const witApi = await connection.getWorkItemTrackingApi();
    
    // 测试 1: 使用 @me 查询
    console.log('Test 1: Query using @me macro');
    const wiql1 = `
      SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
      FROM WorkItems
      WHERE [System.AssignedTo] = @me
      AND [System.State] IN ('New', 'Active')
      AND [System.TeamProject] = 'WiNEX-Outpatient'
    `;
    
    console.log('WIQL:', wiql1.trim());
    const result1 = await witApi.queryByWiql({ query: wiql1 });
    console.log(`Result: ${result1.workItems?.length || 0} work items\n`);
    
    // 测试 2: 查询所有工作项（不限制 AssignedTo）
    console.log('Test 2: Query all work items in project');
    const wiql2 = `
      SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
      FROM WorkItems
      WHERE [System.State] IN ('New', 'Active')
      AND [System.TeamProject] = 'WiNEX-Outpatient'
    `;
    
    console.log('WIQL:', wiql2.trim());
    const result2 = await witApi.queryByWiql({ query: wiql2 });
    console.log(`Result: ${result2.workItems?.length || 0} work items`);
    
    if (result2.workItems && result2.workItems.length > 0) {
      console.log('\nWork items found:');
      
      // 获取详情
      const ids = result2.workItems.map(wi => wi.id).slice(0, 5);
      const details = await witApi.getWorkItems(ids, null, null, 'All');
      
      details.forEach(wi => {
        const assignedTo = wi.fields['System.AssignedTo'];
        let assignedName = 'Unassigned';
        if (assignedTo) {
          if (typeof assignedTo === 'string') {
            assignedName = assignedTo;
          } else if (assignedTo.displayName) {
            assignedName = assignedTo.displayName;
          } else if (assignedTo.uniqueName) {
            assignedName = assignedTo.uniqueName;
          }
        }
        
        console.log(`  #${wi.id}: ${wi.fields['System.Title']}`);
        console.log(`     State: ${wi.fields['System.State']} | Assigned: ${assignedName}`);
      });
      
      console.log('\n☝ Check the "Assigned" field format above.');
      console.log('If different from your username, that\'s why @me query returns empty.');
    }
    
    // 测试 3: 使用具体用户名查询（从配置文件）
    if (config.username) {
      console.log(`\nTest 3: Query using username: ${config.username}`);
      const wiql3 = `
        SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
        FROM WorkItems
        WHERE [System.AssignedTo] = '${config.username}'
        AND [System.State] IN ('New', 'Active')
        AND [System.TeamProject] = 'WiNEX-Outpatient'
      `;
      
      try {
        const result3 = await witApi.queryByWiql({ query: wiql3 });
        console.log(`Result: ${result3.workItems?.length || 0} work items`);
      } catch (e) {
        console.log(`Error: ${e.message}`);
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();
