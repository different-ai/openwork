import { expect } from "vitest";
import { test } from "@openwork/testkit";
import zh from "../../apps/app/src/i18n/locales/zh.ts";

const settingsSidebarCopy = [
  ["dashboard.back_to_app", "返回应用"],
  ["settings.tab_general", "设置"],
  ["settings.group_workspace", "工作区"],
  ["settings.tab_preferences", "偏好设置"],
  ["settings.tab_permissions", "权限"],
  ["settings.tab_extensions", "资料库"],
  ["settings.tab_advanced", "高级"],
  ["settings.group_global", "全局"],
  ["settings.tab_ai_providers", "AI 模型提供商"],
  ["settings.tab_appearance", "外观"],
  ["settings.tab_environment", "环境变量"],
  ["settings.tab_updates", "更新"],
  ["settings.tab_recovery", "恢复"],
  ["settings.group_cloud", "云端"],
  ["settings.tab_cloud_account", "账户"],
] as const;

test("Simplified Chinese settings sidebar copy is defined", ({ evidence }) => {
  for (const [key, expected] of settingsSidebarCopy) {
    expect(zh[key]).toBe(expected);
  }

  evidence.fact(
    "Approved settings sidebar labels have Simplified Chinese resources",
    `Verified ${settingsSidebarCopy.length} approved settings sidebar labels in the Simplified Chinese dictionary.`,
    true,
  );
});
