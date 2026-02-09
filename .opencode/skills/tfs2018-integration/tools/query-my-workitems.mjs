#!/usr/bin/env node
/**
 * 查询我的工作项 - 任务控制中心快捷工具
 *
 * 使用方法:
 *   node query-my-workitems.mjs [project] [states]
 *
 * 示例:
 *   node query-my-workitems.mjs                    # 查询所有项目的已建议、活动任务（默认）
 *   node query-my-workitems.mjs WiNEX-Outpatient  # 查询特定项目
 *   node query-my-workitems.mjs "" 已建议,活动      # 查询所有项目的已建议、活动
 *   node query-my-workitems.mjs WiNEX-Outpatient 已解决,已关闭  # 查询所有状态
 */

import TaskCenterTFSClient from "./task-center-integration.mjs";

async function main() {
  const args = process.argv.slice(2);
  const project = args[0]; // null = 查询所有项目
  const statesArg = args[1] || "已建议,活动"; // TFS 2018 中文状态名
  const states = statesArg.split(",").map((s) => s.trim());

  // ANSI 颜色（TFS 2018 中文状态）
  const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    已建议: "\x1b[36m", // 青色 - New/Proposed
    活动: "\x1b[33m", // 黄色 - Active
    已解决: "\x1b[32m", // 绿色 - Resolved
    已关闭: "\x1b[90m", // 灰色 - Closed
    default: "\x1b[37m",
  };

  const resetColor = colors.reset;

  const print = (color, message) => {
    console.log(`${colors[color]}${message}${colors.reset}`);
  };

  const printHeader = (title) => {
    console.log();
    print("cyan", "═══════════════════════════════════════════════════════");
    print("bright", `  ${title}`);
    print("cyan", "═══════════════════════════════════════════════════════");
    console.log();
  };

  printHeader("Task Center - My Work Items");

  if (project) {
    print("white", `Project: ${project}`);
  } else {
    print("white", "Project: All Projects (查询所有项目)");
  }
  print("dim", `States: ${states.join(", ")}`);
  console.log();

  print("dim", "提示:");
  print("white", "  • 查询特定项目: node query-my-workitems.mjs WiNEX-Outpatient");
  print("white", "  • 查询所有项目: node query-my-workitems.mjs");
  print("white", "  • 查询其他状态: node query-my-workitems.mjs \"\" 已解决,已关闭");
  console.log();
  print("dim", "TFS 2018 状态名:");
  print("white", "  • \"已建议\" = New/Proposed (新建/建议)");
  print("white", "  • \"活动\" = Active (进行中)");
  print("white", "  • \"已解决\" = Resolved (已解决)");
  print("white", "  • \"已关闭\" = Closed (已关闭)");
  console.log();

  try {
    const client = new TaskCenterTFSClient();

    print("dim", "Fetching...\n");

    const tasks = await client.getMyWorkItems({
      project,
      states,
      top: 100,
    });

    if (tasks.length === 0) {
      print("yellow", "✓ No work items found matching your criteria.");
      console.log();
      print("white", "可能原因:");
      print("dim", "  1. 没有分配给当前用户的工作项");
      print("dim", "  2. 工作项在其他状态（如：已解决、已关闭）");
      print("dim", "  3. 用户名不匹配（当前: WINNING\\g_wj）");
      console.log();
      print("white", "尝试:");
      print("white", "  1. node query-my-workitems.mjs \"\" 已解决,已关闭");
      print("white", "  2. node query-my-workitems.mjs WiNEX-Outpatient");
      print("white", "  3. 检查 TFS 网页上工作项的分配情况");
      return;
    }

    print("green", `✓ Found ${tasks.length} work item(s)\n`);

    // 按状态分组
    const grouped = tasks.reduce((acc, task) => {
      acc[task.state] = acc[task.state] || [];
      acc[task.state].push(task);
      return acc;
    }, {});

    // 按优先级排序的状态（TFS 2018 中文状态）
    const stateOrder = ["活动", "已建议", "已解决", "已关闭"];
    const sortedStates = Object.keys(grouped).sort((a, b) => {
      const indexA = stateOrder.indexOf(a);
      const indexB = stateOrder.indexOf(b);
      if (indexA === -1 && indexB === -1) return a.localeCompare(b);
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });

    for (const state of sortedStates) {
      const items = grouped[state];
      const stateColor = colors[state] ? state : "default";

      console.log(`${colors[stateColor]}[ ${state} ]${resetColor} (${items.length})`);
      console.log("─".repeat(70));

      items.forEach((task, index) => {
        const isLast = index === items.length - 1;
        const prefix = isLast ? "└──" : "├──";
        const id = String(task.id).padEnd(7);
        const type = task.workItemType.padEnd(10);
        const priority = `P${task.priority}`;
        const projectLabel = task.project ? task.project.padEnd(18) : "No Project".padEnd(18);

        console.log(`${prefix} #${id} [${priority}] [${type}] [${projectLabel}] ${task.title}`);

        // 标签
        if (task.tags.length > 0) {
          const tagPrefix = isLast ? "    " : "│   ";
          const tagStr = task.tags.slice(0, 3).map((t) => `#${t}`).join(" ");
          const moreTags = task.tags.length > 3 ? ` +${task.tags.length - 3}` : "";
          console.log(`${tagPrefix}${colors.dim}Tags: ${tagStr}${moreTags}${colors.reset}`);
        }

        // 修改时间
        const timePrefix = isLast ? "    " : "│   ";
        const relativeTime = formatRelativeTime(task.changedDate);
        console.log(`${timePrefix}${colors.dim}Updated: ${relativeTime}${colors.reset}`);

        if (!isLast) {
          console.log("│");
        }
      });

      console.log();
    }

    // 汇总统计
    console.log("─".repeat(70));
    print("bright", "Summary:");
    sortedStates.forEach((state) => {
      const count = grouped[state].length;
      const stateColor = colors[state] ? state : "default";
      print(stateColor, `  ${state}: ${count}`);
    });
    print("white", `  Total: ${tasks.length}`);
    console.log();
  } catch (error) {
    print("red", `✗ Error: ${error.message}`);

    if (error.message.includes("配置文件不存在")) {
      console.log();
      print("white", "提示: 请先配置 TFS 认证信息");
      console.log("  1. 登录 TFS: http://tfs2018-web.winning.com.cn:8080/tfs/");
      console.log("  2. 用户头像 → 安全 → +添加 → 个人访问令牌");
      console.log("  3. 创建 tools/config/tfs-config.json 文件:");
      console.log("     {");
      console.log("       \"serverUrl\": \"http://tfs2018-web.winning.com.cn:8080/tfs/WINNING-6.0\",");
      console.log("       \"pat\": \"your-token\"");
      console.log("     }");
    }

    process.exit(1);
  }
}

function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString("zh-CN");
}

main();
