import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "the home sidebar renders approved Simplified Chinese labels"
  : "Simplified Chinese home sidebar skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in";

const expectedLabels = ["搜索会话", "通知", "工作区", "登录", "与 OpenWork 云端同步"];

test.skipIf(!appSpecsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  await using app = await desktop({ name: "sidebar-simplified-chinese" });
  await createAndSelectWorkspace(app, { path: `/tmp/openwork-sidebar-simplified-chinese-${Date.now()}` });
  await evalIn(app, `localStorage.setItem("openwork.language", "zh"); location.reload(); true`);

  await waitFor(app, `(() => {
    const sidebar = document.querySelector('[data-sidebar="sidebar"]');
    const text = sidebar?.innerText ?? "";
    return ${JSON.stringify(expectedLabels)}.every((label) => text.includes(label));
  })()`, { timeoutMs: 60_000, label: "Simplified Chinese home sidebar labels" });

  const sidebarText = await evalIn(app, `document.querySelector('[data-sidebar="sidebar"]')?.innerText ?? ""`);
  expect(typeof sidebarText).toBe("string");
  for (const label of expectedLabels) {
    expect(sidebarText).toContain(label);
  }
  evidence.fact(
    "The signed-out home sidebar renders the approved Simplified Chinese labels",
    `The visible sidebar includes: ${expectedLabels.join("、")}。`,
    true,
  );
});
