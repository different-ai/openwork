import { expect } from "vitest";
import { test } from "@openwork/testkit";
import zh from "../../apps/app/src/i18n/locales/zh.ts";

const homeSidebarCopy = [
  ["workspace_list.search_sessions", "搜索会话"],
  ["notifications.title", "通知"],
  ["workspace_list.title", "工作区"],
  ["den.signin_button", "登录"],
  ["account.sync_with_cloud", "与 OpenWork 云端同步"],
] as const;

test("Simplified Chinese home sidebar copy is defined", ({ evidence }) => {
  for (const [key, expected] of homeSidebarCopy) {
    expect(zh[key]).toBe(expected);
  }

  evidence.fact(
    "Approved home sidebar labels have Simplified Chinese resources",
    `Verified ${homeSidebarCopy.length} approved home sidebar labels in the Simplified Chinese dictionary.`,
    true,
  );
});
