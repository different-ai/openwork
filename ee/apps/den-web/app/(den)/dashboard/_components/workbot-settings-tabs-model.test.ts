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

test("a link to the last 7 days opens Members' agents", () => {
  assert.equal(workbotSettingsTabForHash("#agent-health", "agent-health"), "agents");
  assert.equal(workbotSettingsTabForHash("#workbot-default-model", "agent-health"), null);
  assert.equal(workbotSettingsTabForHash("", "agent-health"), null);
});
