#!/usr/bin/env node
/**
 * 门诊医生站工作项与代码提交分析工具
 * 分析近10天已解决的工作项及关联的代码提交风险
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TFSClient from './tfs-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 门诊医生站项目ID
const OUTPATIENT_PROJECT_ID = 'e17bb6a1-2677-4695-8202-c3c296bbd05c';
const OUTPATIENT_PROJECT_NAME = 'WiNEX-Outpatient';

/**
 * 格式化日期为TFS WIQL格式 (TFS 2018 需要日期格式，不能包含时间部分)
 */
function formatDateForWIQL(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 获取近10天已解决的工作项
 */
async function getResolvedWorkItems(client, days = 10) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const startDateStr = formatDateForWIQL(startDate);
  const endDateStr = formatDateForWIQL(endDate);

  // 查询已解决或已关闭的工作项
  // 注意: TFS 2018 不支持 System.ClosedDate 和 System.ResolvedDate 字段
  const wiql = `
    SELECT [System.Id], [System.Title], [System.WorkItemType],
           [System.State], [System.AssignedTo], [System.CreatedDate],
           [System.ChangedDate],
           [System.Description], [Microsoft.VSTS.Common.Priority],
           [Microsoft.VSTS.Common.Severity], [System.Reason]
    FROM WorkItems
    WHERE [System.TeamProject] = '${OUTPATIENT_PROJECT_NAME}'
    AND (
      [System.State] = 'Resolved' OR
      [System.State] = 'Closed'
    )
    AND [System.ChangedDate] >= '${startDateStr}'
    AND [System.ChangedDate] <= '${endDateStr}'
    ORDER BY [System.ChangedDate] DESC
  `;

  const workItems = await client.queryWorkItems(wiql);
  return workItems;
}

/**
 * 获取项目的所有仓库
 */
async function getProjectRepositories(client) {
  return await client.getRepositories(OUTPATIENT_PROJECT_NAME);
}

/**
 * 获取最近的代码提交
 */
async function getRecentCommits(client, repositoryId, days = 10) {
  const gitApi = await client.getGitApi();
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // 注意：TFS 2018 API的日期过滤可能不工作，需要在客户端进行过滤
  // 先获取最近的一些提交，然后在客户端按日期过滤
  const commits = await gitApi.getCommits(
    repositoryId,
    OUTPATIENT_PROJECT_NAME,
    null,  // branch
    null,  // requestorId
    null,  // itemPath
    200,   // top limit - 减少获取数量
    null,  // skip
    null,  // includeLinks
    null,  // fromDate - TFS 2018可能不支持
    null   // toDate - TFS 2018可能不支持
  );

  // 客户端过滤：只保留指定日期范围内的提交
  const filteredCommits = commits.filter(commit => {
    const commitDate = new Date(commit.author?.date || commit.committer?.date);
    return commitDate >= startDate && commitDate <= endDate;
  });

  return filteredCommits;
}

/**
 * 获取提交的详细变更（文件变更）
 */
async function getCommitChanges(client, repositoryId, projectId, commitId) {
  const gitApi = await client.getGitApi();
  try {
    const changes = await gitApi.getChanges(commitId, repositoryId, projectId);
    return changes;
  } catch (error) {
    console.warn(`无法获取提交 ${commitId} 的变更详情: ${error.message}`);
    return [];
  }
}

/**
 * 分析代码提交风险（不获取详细变更）
 */
function analyzeCommitRisk(commit, changes = []) {
  const riskFactors = [];
  let riskLevel = 'low';

  // 检查是否有关联的工作项
  const workItems = commit.workItems || [];
  const hasWorkItems = workItems.length > 0;

  if (!hasWorkItems) {
    riskFactors.push('提交未关联工作项');
    riskLevel = 'medium';
  }

  // 检查提交注释
  const comment = commit.comment || '';
  if (!comment || comment.trim().length === 0) {
    riskFactors.push('提交注释为空');
    riskLevel = riskLevel === 'high' ? 'high' : 'medium';
  }

  // 检查是否有Merge提交
  if (comment.toLowerCase().includes('merge')) {
    riskFactors.push('合并提交');
  }

  // 检查提交注释中的风险关键词
  const riskyKeywords = ['hotfix', 'urgent', '紧急', '修复bug', 'fix bug', 'critical'];
  const hasRiskyKeyword = riskyKeywords.some(kw =>
    comment.toLowerCase().includes(kw.toLowerCase())
  );

  if (hasRiskyKeyword) {
    riskLevel = 'high';
    riskFactors.push('包含紧急修复或关键词');
  }

  return {
    riskLevel,
    riskFactors,
    hasWorkItems,
    workItemCount: workItems.length,
    changeCount: 0 // 未获取详细变更
  };
}

/**
 * 分析工作项风险
 */
function analyzeWorkItemRisk(workItem) {
  const riskFactors = [];
  let riskLevel = 'low';

  const fields = workItem.fields || {};
  const state = fields['System.State'] || '';
  const workItemType = fields['System.WorkItemType'] || '';
  const priority = fields['Microsoft.VSTS.Common.Priority'];
  const severity = fields['Microsoft.VSTS.Common.Severity'];

  // 检查优先级
  if (priority === '1') {
    riskLevel = 'high';
    riskFactors.push('高优先级工作项');
  } else if (priority === '2') {
    riskLevel = riskLevel === 'high' ? 'high' : 'medium';
    riskFactors.push('中高优先级工作项');
  }

  // 检查严重性
  if (severity && ['1 - Critical', 'Critical', '1'].includes(severity)) {
    riskLevel = 'high';
    riskFactors.push('严重缺陷');
  }

  // 检查工作项类型
  if (workItemType === 'Bug') {
    riskLevel = riskLevel === 'high' ? 'high' : 'medium';
    riskFactors.push('缺陷修复');
  }

  return {
    riskLevel,
    riskFactors,
    state,
    workItemType,
    priority,
    severity
  };
}

/**
 * 生成分析报告
 */
async function generateReport(client) {
  console.log('开始分析门诊医生站近10天的工作项和代码提交...\n');

  // 获取工作项
  console.log('1. 获取已解决的工作项...');
  const workItems = await getResolvedWorkItems(client, 10);
  console.log(`   找到 ${workItems.length} 个已解决的工作项\n`);

  // 获取仓库
  console.log('2. 获取项目仓库信息...');
  const repositories = await getProjectRepositories(client);
  console.log(`   找到 ${repositories.length} 个仓库\n`);

  // 获取代码提交
  const allCommits = [];
  let totalCommitCount = 0;

  for (const repo of repositories) {
    console.log(`3. 获取仓库 "${repo.name}" 的提交记录...`);
    const commits = await getRecentCommits(client, repo.id, 10);
    console.log(`   找到 ${commits.length} 个提交\n`);
    totalCommitCount += commits.length;

    // 不获取详细变更，只收集提交基本信息
    for (const commit of commits) {
      allCommits.push({
        ...commit,
        repositoryName: repo.name,
        repositoryId: repo.id
      });
    }
  }

  // 分析风险
  console.log('4. 分析代码风险...\n');

  const reportData = {
    summary: {
      analysisDate: new Date().toISOString(),
      dateRange: '近10天',
      totalWorkItems: workItems.length,
      totalCommits: allCommits.length,
      totalRepositories: repositories.length
    },
    workItems: [],
    commits: [],
    riskSummary: {
      high: 0,
      medium: 0,
      low: 0
    }
  };

  // 分析工作项
  for (const wi of workItems) {
    const fields = wi.fields || {};
    const risk = analyzeWorkItemRisk(wi);

    reportData.workItems.push({
      id: wi.id,
      title: fields['System.Title'],
      type: risk.workItemType,
      state: risk.state,
      priority: risk.priority,
      severity: risk.severity,
      assignedTo: fields['System.AssignedTo']?.displayName || 'Unassigned',
      createdDate: fields['System.CreatedDate'],
      changedDate: fields['System.ChangedDate'],
      risk: risk
    });

    reportData.riskSummary[risk.riskLevel]++;
  }

  // 分析代码提交
  for (const commit of allCommits) {
    const risk = analyzeCommitRisk(commit, []);

    // 获取关联的工作项
    const workItems = (commit.workItems || []).map(wi => ({
      id: wi.id,
      title: wi.title || ''
    }));

    reportData.commits.push({
      commitId: commit.commitId.substring(0, 8),
      fullCommitId: commit.commitId,
      author: commit.author?.displayName || 'Unknown',
      pusher: commit.pusher?.displayName || 'Unknown',
      comment: commit.comment,
      date: commit.author?.date || commit.committer?.date,
      repository: commit.repositoryName,
      workItems: workItems,
      changeCount: 0, // 未获取详细变更
      changes: [],
      risk: risk
    });

    reportData.riskSummary[risk.riskLevel]++;
  }

  return reportData;
}

/**
 * 生成Markdown报告
 */
function generateMarkdownReport(data) {
  const lines = [];

  // 标题
  lines.push('# 门诊医生站工作项与代码提交分析报告');
  lines.push('');
  lines.push(`**生成时间**: ${new Date(data.summary.analysisDate).toLocaleString('zh-CN')}`);
  lines.push(`**分析范围**: ${data.summary.dateRange}`);
  lines.push('');

  // 执行摘要
  lines.push('## 执行摘要');
  lines.push('');
  lines.push('| 指标 | 数量 |');
  lines.push('|------|------|');
  lines.push('| 已解决工作项 | ' + data.summary.totalWorkItems + ' |');
  lines.push('| 代码提交 | ' + data.summary.totalCommits + ' |');
  lines.push('| 涉及仓库 | ' + data.summary.totalRepositories + ' |');
  lines.push('');

  // 风险概览
  lines.push('## 风险概览');
  lines.push('');
  lines.push('| 风险等级 | 数量 |');
  lines.push('|----------|------|');
  lines.push('| 高风险 | ' + data.riskSummary.high + ' |');
  lines.push('| 中风险 | ' + data.riskSummary.medium + ' |');
  lines.push('| 低风险 | ' + data.riskSummary.low + ' |');
  lines.push('');

  // 工作项详情
  lines.push('## 已解决工作项详情');
  lines.push('');

  if (data.workItems.length === 0) {
    lines.push('未找到已解决的工作项。');
  } else {
    // 按风险等级分组
    const highRiskWorkItems = data.workItems.filter(wi => wi.risk.riskLevel === 'high');
    const mediumRiskWorkItems = data.workItems.filter(wi => wi.risk.riskLevel === 'medium');
    const lowRiskWorkItems = data.workItems.filter(wi => wi.risk.riskLevel === 'low');

    if (highRiskWorkItems.length > 0) {
      lines.push('### 高风险工作项');
      lines.push('');
      for (const wi of highRiskWorkItems) {
        lines.push(`#### [${wi.id}] ${wi.title}`);
        lines.push('');
        lines.push('- **类型**: ' + wi.type);
        lines.push('- **状态**: ' + wi.state);
        lines.push('- **优先级**: ' + (wi.priority || 'N/A'));
        lines.push('- **严重性**: ' + (wi.severity || 'N/A'));
        lines.push('- **分配给**: ' + wi.assignedTo);
        lines.push('- **变更日期**: ' + new Date(wi.changedDate).toLocaleString('zh-CN'));
        lines.push('- **风险因素**: ' + wi.risk.riskFactors.join(', '));
        lines.push('');
      }
    }

    if (mediumRiskWorkItems.length > 0) {
      lines.push('### 中风险工作项');
      lines.push('');
      for (const wi of mediumRiskWorkItems) {
        lines.push(`#### [${wi.id}] ${wi.title}`);
        lines.push('');
        lines.push('- **类型**: ' + wi.type);
        lines.push('- **状态**: ' + wi.state);
        lines.push('- **优先级**: ' + (wi.priority || 'N/A'));
        lines.push('- **分配给**: ' + wi.assignedTo);
        lines.push('- **变更日期**: ' + new Date(wi.changedDate).toLocaleString('zh-CN'));
        lines.push('- **风险因素**: ' + wi.risk.riskFactors.join(', '));
        lines.push('');
      }
    }

    if (lowRiskWorkItems.length > 0) {
      lines.push('### 低风险工作项');
      lines.push('');
      for (const wi of lowRiskWorkItems) {
        lines.push(`- [${wi.id}] ${wi.title} (${wi.type}, ${wi.assignedTo})`);
      }
      lines.push('');
    }
  }

  // 代码提交详情
  lines.push('## 代码提交详情');
  lines.push('');

  if (data.commits.length === 0) {
    lines.push('未找到代码提交记录。');
  } else {
    // 按风险等级分组
    const highRiskCommits = data.commits.filter(c => c.risk.riskLevel === 'high');
    const mediumRiskCommits = data.commits.filter(c => c.risk.riskLevel === 'medium');
    const lowRiskCommits = data.commits.filter(c => c.risk.riskLevel === 'low');

    if (highRiskCommits.length > 0) {
      lines.push('### 高风险提交');
      lines.push('');
      for (const commit of highRiskCommits) {
        lines.push(`#### ${commit.commitId} - ${commit.comment?.substring(0, 80) || '无注释'}`);
        lines.push('');
        lines.push('- **作者**: ' + commit.author);
        lines.push('- **仓库**: ' + commit.repository);
        lines.push('- **日期**: ' + new Date(commit.date).toLocaleString('zh-CN'));
        lines.push('- **关联工作项**: ' + (commit.workItems.map(wi => `#${wi.id}`).join(', ') || '无'));
        lines.push('- **风险因素**: ' + commit.risk.riskFactors.join(', '));
        lines.push('');
      }
    }

    if (mediumRiskCommits.length > 0) {
      lines.push('### 中风险提交');
      lines.push('');
      for (const commit of mediumRiskCommits) {
        lines.push(`#### ${commit.commitId} - ${commit.comment?.substring(0, 80) || '无注释'}`);
        lines.push('');
        lines.push('- **作者**: ' + commit.author);
        lines.push('- **仓库**: ' + commit.repository);
        lines.push('- **日期**: ' + new Date(commit.date).toLocaleString('zh-CN'));
        lines.push('- **关联工作项**: ' + (commit.workItems.map(wi => `#${wi.id}`).join(', ') || '无'));
        lines.push('- **风险因素**: ' + commit.risk.riskFactors.join(', '));
        lines.push('');
      }
    }

    if (lowRiskCommits.length > 0) {
      lines.push('### 低风险提交');
      lines.push('');
      for (const commit of lowRiskCommits) {
        const workItemRefs = commit.workItems.map(wi => `#${wi.id}`).join(', ');
        lines.push(`- ${commit.commitId} - ${commit.comment?.substring(0, 60) || '无注释'} (${commit.author}, ${commit.repository}${workItemRefs ? ', ' + workItemRefs : ''})`);
      }
      lines.push('');
    }
  }

  // 风险建议
  lines.push('## 风险分析与建议');
  lines.push('');

  const totalRisks = data.riskSummary.high + data.riskSummary.medium;
  if (totalRisks === 0) {
    lines.push('当前无显著风险。建议继续保持良好的开发规范。');
  } else {
    lines.push(`检测到 ${data.riskSummary.high} 个高风险项和 ${data.riskSummary.medium} 个中风险项，建议：`);
    lines.push('');
    lines.push('1. **高风险项处理**');
    lines.push('   - 优先审查高风险的代码提交');
    lines.push('   - 对高优先级工作项进行额外的测试验证');
    lines.push('   - 对数据库和配置文件变更进行特别审查');
    lines.push('');
    lines.push('2. **代码提交规范**');
    lines.push('   - 确保所有提交都关联到工作项');
    lines.push('   - 避免大范围的代码变更，考虑拆分为多个小提交');
    lines.push('   - 提交注释应清晰描述变更内容和工作项关联');
    lines.push('');
    lines.push('3. **持续改进**');
    lines.push('   - 定期审查高风险工作项的处理流程');
    lines.push('   - 加强代码审查机制');
    lines.push('   - 对高风险变更进行更全面的回归测试');
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * 主函数
 */
async function main() {
  try {
    const client = new TFSClient();
    const reportData = await generateReport(client);
    const markdown = generateMarkdownReport(reportData);

    // 输出到文件
    const reportPath = path.join(__dirname, '..', 'outpatient-report.md');
    fs.writeFileSync(reportPath, markdown, 'utf-8');

    console.log('报告已生成: ' + reportPath);
    console.log('');

    // 输出摘要
    console.log('=== 分析摘要 ===');
    console.log(`已解决工作项: ${reportData.summary.totalWorkItems}`);
    console.log(`代码提交: ${reportData.summary.totalCommits}`);
    console.log(`风险等级: 高(${reportData.riskSummary.high}) 中(${reportData.riskSummary.medium}) 低(${reportData.riskSummary.low})`);

  } catch (error) {
    console.error('分析失败:', error.message);
    process.exit(1);
  }
}

// 执行
main();
