#!/usr/bin/env node
/**
 * 测试 - 查询项目中所有工作项（不限状态）
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
  console.log('=== Query All Work Items (Any State) ===\n');
  
  try {
    const witApi = await connection.getWorkItemTrackingApi();
    
    // 查询 WiNEX-Outpatient 项目中所有工作项（不限状态）
    const wiql = `
      SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.WorkItemType]
      FROM WorkItems
      WHERE [System.TeamProject] = 'WiNEX-Outpatient'
      ORDER BY [System.ChangedDate] DESC
    `;
    
    console.log('Querying all work items in WiNEX-Outpatient...\n');
    const result = await witApi.queryByWiql({ query: wiql });
    
    console.log(`Total work items in project: ${result.workItems?.length || 0}`);
    
    if (result.workItems && result.workItems.length > 0) {
      // 获取详情
      const ids = result.workItems.map(wi => wi.id).slice(0, 10);
      const details = await witApi.getWorkItems(ids, null, null, 'All');
      
      console.log('\nRecent work items:');
      console.log('─'.repeat(70));
      
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
        
        const id = String(wi.id).padEnd(8);
        const type = (wi.fields['System.WorkItemType'] || 'Unknown').padEnd(12);
        const state = (wi.fields['System.State'] || 'Unknown').padEnd(10);
        
        console.log(`#${id} [${type}] [${state}] ${wi.fields['System.Title']}`);
        console.log(`       Assigned: ${assignedName}`);
      });
      
      if (result.workItems.length > 10) {
        console.log(`\n... and ${result.workItems.length - 10} more`);
      }
    } else {
      console.log('\nNo work items found in WiNEX-Outpatient project.');
      console.log('\nPossible reasons:');
      console.log('1. The project exists but has no work items');
      console.log('2. You may not have permission to view work items');
      console.log('3. Work items might be in a different project');
    }
    
    // 同时查询所有项目看看
    console.log('\n\n=== Query All Projects (Top 10) ===\n');
    const wiqlAll = `
      SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.TeamProject]
      FROM WorkItems
      ORDER BY [System.ChangedDate] DESC
    `;
    
    const resultAll = await witApi.queryByWiql({ query: wiqlAll });
    console.log(`Total work items across all projects: ${resultAll.workItems?.length || 0}`);
    
    if (resultAll.workItems && resultAll.workItems.length > 0) {
      const ids = resultAll.workItems.map(wi => wi.id).slice(0, 10);
      const details = await witApi.getWorkItems(ids, null, null, 'All');
      
      console.log('\nRecent work items from all projects:');
      console.log('─'.repeat(70));
      
      details.forEach(wi => {
        const project = (wi.fields['System.TeamProject'] || 'Unknown').padEnd(15);
        const id = String(wi.id).padEnd(8);
        const state = (wi.fields['System.State'] || 'Unknown').padEnd(10);
        
        console.log(`[${project}] #${id} [${state}] ${wi.fields['System.Title']}`);
      });
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();
