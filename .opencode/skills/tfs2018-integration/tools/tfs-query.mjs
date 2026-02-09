#!/usr/bin/env node
/**
 * TFS Query Command Line Tool
 * 卫宁健康 WINNING-6.0 团队
 *
 * 命令行查询工具，用于快速查询 TFS 工作项
 */

import TFSClient from './tfs-client.mjs';

/**
 * 格式化输出工作项
 */
function formatWorkItem(workItem) {
  const id = workItem.id;
  const title = workItem.fields['System.Title'] || '无标题';
  const state = workItem.fields['System.State'] || '未知';
  const assignedTo = workItem.fields['System.AssignedTo']?.displayName || '未分配';
  const type = workItem.fields['System.WorkItemType'] || '';
  const project = workItem.fields['System.TeamProject'] || '';

  return `[${id}] ${title}\n    类型: ${type} | 状态: ${state} | 分配给: ${assignedTo} | 项目: ${project}`;
}

/**
 * 格式化输出工作项（表格格式）
 */
function formatWorkItemTable(workItems) {
  if (workItems.length === 0) {
    console.log('未找到工作项');
    return;
  }

  console.log(`\n找到 ${workItems.length} 个工作项:\n`);

  workItems.forEach(wi => {
    const id = String(wi.id).padEnd(8);
    const state = (wi.fields['System.State'] || '未知').padEnd(12);
    const type = (wi.fields['System.WorkItemType'] || '').padEnd(12);
    const title = wi.fields['System.Title'] || '无标题';
    const assignedTo = wi.fields['System.AssignedTo']?.displayName || '未分配';

    console.log(`${id} [${state}] [${type}] ${title}`);
    console.log(`    分配给: ${assignedTo}`);
    console.log();
  });
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    const client = new TFSClient();

    switch (command) {
      case 'my-tasks': {
        const project = args[1] || null;
        console.log(`查询分配给我的任务${project ? ` (项目: ${project})` : ''}...`);
        const tasks = await client.getMyTasks(project);
        formatWorkItemTable(tasks);
        break;
      }

      case 'bugs': {
        const project = args[1] || null;
        console.log(`查询未关闭的 Bug${project ? ` (项目: ${project})` : ''}...`);
        const bugs = await client.getOpenBugs(project);
        formatWorkItemTable(bugs);
        break;
      }

      case 'resolved': {
        const project = args[1] || null;
        const days = args[2] ? parseInt(args[2]) : 7;
        console.log(`查询近 ${days} 天已解决的工作项${project ? ` (项目: ${project})` : ''}...`);
        const items = await client.getRecentResolvedWorkItems(project, days);
        formatWorkItemTable(items);
        break;
      }

      case 'get': {
        const id = parseInt(args[1]);
        if (!id) {
          console.error('请提供工作项 ID');
          process.exit(1);
        }
        console.log(`获取工作项 ${id}...`);
        const workItem = await client.getWorkItem(id);
        console.log(formatWorkItem(workItem));
        console.log(`\n描述:\n${workItem.fields['System.Description'] || '无描述'}`);
        break;
      }

      case 'get-multi': {
        const ids = args.slice(1).map(s => parseInt(s));
        if (ids.length === 0) {
          console.error('请提供至少一个工作项 ID');
          process.exit(1);
        }
        console.log(`获取工作项: ${ids.join(', ')}...`);
        const workItems = await client.getWorkItems(ids);
        formatWorkItemTable(workItems);
        break;
      }

      case 'projects': {
        const projects = client.getProjects();
        console.log('\n可用项目列表:\n');
        Object.entries(projects).forEach(([name, id]) => {
          console.log(`  ${name.padEnd(30)} ${id}`);
        });
        console.log(`\n共 ${Object.keys(projects).length} 个项目\n`);
        break;
      }

      case 'repos': {
        const project = args[1];
        if (!project) {
          console.error('请提供项目名称');
          process.exit(1);
        }
        if (!client.hasProject(project)) {
          console.error(`项目不存在: ${project}`);
          console.log('使用 "projects" 命令查看可用项目');
          process.exit(1);
        }
        console.log(`获取项目 "${project}" 的 Git 仓库...`);
        const repos = await client.getRepositories(project);
        console.log(`\n找到 ${repos.length} 个仓库:\n`);
        repos.forEach(repo => {
          console.log(`  ${repo.name.padEnd(40)} ${repo.id}`);
          console.log(`    默认分支: ${repo.defaultBranch || '无'}`);
          console.log(`    URL: ${repo.remoteUrl || repo.url}`);
          console.log();
        });
        break;
      }

      case 'commits': {
        const project = args[1];
        const repoId = args[2];
        const top = args[3] ? parseInt(args[3]) : 20;
        const days = args[4] ? parseInt(args[4]) : null;

        if (!project || !repoId) {
          console.error('用法: commits <project> <repoId> [top] [days]');
          process.exit(1);
        }

        console.log(`获取最近 ${top} 条提交记录${days ? ` (近 ${days} 天)` : ''}...`);
        const commits = await client.getCommits(repoId, project, top, days);

        console.log(`\n找到 ${commits.length} 条提交:\n`);
        commits.forEach(commit => {
          const shortId = commit.commitId.substring(0, 8);
          const author = commit.author?.displayName || commit.author?.name || '未知';
          const date = new Date(commit.author?.date || commit.commitDate).toLocaleString('zh-CN');
          const comment = commit.comment || '<无评论>';
          const workItemCount = commit.workItems?.length || 0;

          console.log(`${shortId} - ${comment}`);
          console.log(`    作者: ${author} | 日期: ${date} | 关联工作项: ${workItemCount}`);
          console.log();
        });
        break;
      }

      case 'check-commit': {
        const project = args[1];
        const repoId = args[2];
        const commitId = args[3];

        if (!project || !repoId || !commitId) {
          console.error('用法: check-commit <project> <repoId> <commitId>');
          process.exit(1);
        }

        console.log(`检查提交 ${commitId.substring(0, 8)} 的工作项关联...`);
        const result = await client.checkCommitWorkItems(repoId, project, commitId);

        console.log(`\n提交: ${result.commitId}`);
        console.log(`关联工作项: ${result.workItemCount} 个`);
        console.log(`状态: ${result.hasWorkItems ? '✓ 已关联' : '✗ 未关联任何工作项'}`);

        if (result.workItemCount > 0) {
          console.log('\n关联的工作项:');
          result.workItems.forEach(wi => {
            console.log(`  - #${wi.id}`);
          });
        }
        console.log();
        break;
      }

      case 'update-state': {
        const id = parseInt(args[1]);
        const newState = args[2];
        const comment = args[3] || null;

        if (!id || !newState) {
          console.error('用法: update-state <workItemId> <newState> [comment]');
          process.exit(1);
        }

        console.log(`更新工作项 ${id} 状态为 "${newState}"...`);
        const updated = await client.updateWorkItemState(id, newState, comment);
        console.log(`\n工作项已更新:`);
        console.log(formatWorkItem(updated));
        break;
      }

      case 'create-task': {
        const project = args[1];
        const title = args[2];
        const description = args[3] || '';
        const assignedTo = args[4] || '';

        if (!project || !title) {
          console.error('用法: create-task <project> <title> [description] [assignedTo]');
          process.exit(1);
        }

        if (!client.hasProject(project)) {
          console.error(`项目不存在: ${project}`);
          process.exit(1);
        }

        console.log(`在项目 "${project}" 中创建任务: ${title}...`);
        const created = await client.createWorkItem(project, 'Task', {
          title,
          description,
          assignedTo,
          priority: 2
        });

        console.log(`\n任务已创建:`);
        console.log(formatWorkItem(created));
        console.log(`\nURL: ${created._links['html']?.href || ''}`);
        break;
      }

      default:
        showHelp();
    }

  } catch (error) {
    console.error(`错误: ${error.message}`);
    if (error.message.includes('配置文件不存在')) {
      console.log('\n请先配置 TFS 认证信息:');
      console.log('  node tools/setup-config.mjs <your-pat-token>');
    }
    process.exit(1);
  }
}

/**
 * 显示帮助信息
 */
function showHelp() {
  console.log(`
TFS Query Tool - 卫宁健康 WINNING-6.0 团队

用法:
  node tfs-query.mjs <command> [options...]

命令:
  my-tasks [project]              查询分配给我的任务（可选指定项目）
  bugs [project]                  查询未关闭的 Bug（可选指定项目）
  resolved [project] [days]       查询近期已解决的工作项（默认7天）
  get <id>                        获取单个工作项详情
  get-multi <id1> [id2...]        批量获取工作项
  projects                        列出所有可用项目
  repos <project>                 获取项目的 Git 仓库列表
  commits <project> <repoId> [top] [days]  获取最近的提交记录（默认20条，可指定天数）
  check-commit <project> <repoId> <commitId>  检查提交的工作项关联
  update-state <id> <state> [comment]  更新工作项状态
  create-task <project> <title> [description] [assignedTo]  创建任务

示例:
  node tfs-query.mjs my-tasks                        # 查询我的所有任务
  node tfs-query.mjs my-tasks "WiNEX-Outpatient"    # 查询门诊项目任务
  node tfs-query.mjs bugs                             # 查询所有 Bug
  node tfs-query.mjs resolved "WiNEX-Outpatient" 10  # 查询门诊近10天已解决工作项
  node tfs-query.mjs get 12345                        # 获取工作项 12345
  node tfs-query.mjs projects                         # 列出所有项目
  node tfs-query.mjs update-state 12345 "Active"      # 更新状态为进行中
  node tfs-query.mjs create-task "OA4.0" "修复登录问题" "" "DOMAIN\\\\user"

首次使用:
  请先运行 node tools/setup-config.mjs <your-pat-token> 配置认证信息
`);
}

// 运行
main();
