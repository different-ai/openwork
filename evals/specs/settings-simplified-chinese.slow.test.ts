import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, go, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "the settings sidebar renders approved Simplified Chinese labels"
  : "Simplified Chinese settings sidebar skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in";

const expectedLabels = [
  "返回应用", "设置", "工作区", "偏好设置", "权限", "资料库", "高级", "全局", "AI 模型提供商", "外观", "环境变量", "更新", "恢复", "云端", "账户",
];

test.skipIf(!appSpecsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  await using app = await desktop({ name: "settings-simplified-chinese" });
  const { workspaceId } = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-settings-simplified-chinese-${Date.now()}`,
  });
  await evalIn(app, `localStorage.setItem("openwork.language", "zh"); location.reload(); true`);
  await go(app, `/workspace/${workspaceId}/settings/general`);

  await waitFor(app, `(() => {
    const sidebar = document.querySelector('[data-sidebar="sidebar"]');
    const text = sidebar?.innerText ?? "";
    return ${JSON.stringify(expectedLabels)}.every((label) => text.includes(label));
  })()`, { timeoutMs: 60_000, label: "Simplified Chinese settings sidebar labels" });

  const sidebarText = await evalIn(app, `document.querySelector('[data-sidebar="sidebar"]')?.innerText ?? ""`);
  expect(typeof sidebarText).toBe("string");
  for (const label of expectedLabels) {
    expect(sidebarText).toContain(label);
  }
  evidence.fact(
    "The settings sidebar renders the approved Simplified Chinese labels",
    `The visible sidebar includes: ${expectedLabels.join("、")}。`,
    true,
  );
});
