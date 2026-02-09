#!/usr/bin/env node
/**
 * Task Automation Helper
 *
 * 生成标准化的 OpenCode 自动化提示词，供 Task Center 调用。
 *
 * Usage:
 *   node task-automation.mjs <workItemId> [phase]
 *
 * Example:
 *   node task-automation.mjs 3424142
 *   node task-automation.mjs 3424142 analyze
 *   node task-automation.mjs 3424142 full
 */

const PHASES = ["analyze", "design", "plan", "implement", "pr", "review", "archive", "full"];

function buildPrompt(id, phase) {
  const workItemId = String(id).trim();
  const selected = (phase || "full").toLowerCase();

  if (!workItemId) {
    throw new Error("workItemId is required");
  }

  if (!PHASES.includes(selected)) {
    throw new Error(`Invalid phase: ${selected}. Allowed: ${PHASES.join(", ")}`);
  }

  const base = `使用 task-automation skill 完整处理 TFS 工作项 #${workItemId}。`;

  const phaseMap = {
    analyze: `分析 TFS 工作项 #${workItemId}，输出 task-analysis.json。`,
    design: `为 TFS 工作项 #${workItemId} 生成 design.md。`,
    plan: `基于 design.md 为 #${workItemId} 生成 plan.md。`,
    implement: `执行 #${workItemId} 的实施计划，完成代码实现。`,
    pr: `为 #${workItemId} 创建 PR 并关联 TFS 工作项。`,
    review: `对 #${workItemId} 的代码执行门禁扫描并输出 review-report.json。`,
    archive: `将 #${workItemId} 标记为已解决/已关闭，并归档。`,
    full: `分析 → 设计 → 计划 → 实现 → 提交 → PR → 审查 → 归档，完整流程处理 #${workItemId}。`,
  };

  return {
    workItemId,
    phase: selected,
    prompt: selected === "full" ? base + " " + phaseMap.full : phaseMap[selected],
  };
}

function main() {
  const args = process.argv.slice(2);
  const workItemId = args[0];
  const phase = args[1] || "full";

  if (!workItemId) {
    console.error("Usage: node task-automation.mjs <workItemId> [phase]");
    console.error("Phases: analyze | design | plan | implement | pr | review | archive | full");
    process.exit(1);
  }

  try {
    const result = buildPrompt(workItemId, phase);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
