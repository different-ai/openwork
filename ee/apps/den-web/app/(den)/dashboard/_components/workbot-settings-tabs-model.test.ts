import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKBOT_SETTINGS_TABS, workbotSettingsParts, workbotSettingsTabForHash } from "./workbot-settings-tabs-model";

test("without tabs the page shows everything, whatever tab was chosen", () => {
  for (const { value } of WORKBOT_SETTINGS_TABS) {
    assert.deepEqual(workbotSettingsParts(false, value), { general: true, agents: "all" });
  }
});

test("each tab shows one part of the settings", () => {
  assert.deepEqual(workbotSettingsParts(true, "general"), { general: true, agents: null });
  assert.deepEqual(workbotSettingsParts(true, "agents"), { general: false, agents: "policy" });
  assert.deepEqual(workbotSettingsParts(true, "context"), { general: false, agents: "sources" });
});

test("a link to the last 7 days opens Proactive Mode", () => {
  assert.equal(workbotSettingsTabForHash("#agent-health", "agent-health"), "agents");
  assert.equal(workbotSettingsTabForHash("#workbot-default-model", "agent-health"), null);
  assert.equal(workbotSettingsTabForHash("", "agent-health"), null);
});

test("every tab has a short name and one sentence on what it is for", async () => {
  const { WORKBOT_SETTINGS_TAB_PURPOSE } = await import("./workbot-settings-tabs-model");
  assert.deepEqual(WORKBOT_SETTINGS_TABS.map((tab) => tab.label), ["General", "Proactive Mode", "Connectors"]);
  for (const { value } of WORKBOT_SETTINGS_TABS) assert.match(WORKBOT_SETTINGS_TAB_PURPOSE[value], /\.$/);
});
