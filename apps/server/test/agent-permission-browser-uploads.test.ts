import { expect, test } from "bun:test";
import type { AgentPermissionRule } from "@openwork/types/den/agent-permissions-runtime";
import { agentPermissionEngineV2Decision, agentPermissionEngineV2Rules, agentPermissionEngineV2ToolHidden } from "../src/agent-permission-engine.js";

test("browser upload rules stay out of the engine grammar and do not change existing tools", () => {
  const rules: AgentPermissionRule[] = [
    { action: "browser_upload", effect: "deny", resource: "*", source: "Everyone" },
    { action: "shell", effect: "ask", resource: "*", source: "Everyone" },
  ];
  expect(agentPermissionEngineV2Rules(rules)).toEqual([{ action: "shell", effect: "ask", resource: "*" }]);
  expect(agentPermissionEngineV2Decision(rules, "browser_upload", ["https://files.example.test"], "allow")).toEqual({ effect: "allow" });
  expect(agentPermissionEngineV2ToolHidden(rules, "webfetch")).toBe(false);
});
