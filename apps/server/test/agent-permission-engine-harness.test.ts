import { describe, expect, test } from "bun:test";
import type { AgentPermissionRule } from "@openwork/types/den/agent-permissions-runtime";
import { agentPermissionEngineV2Decision, agentPermissionEngineV2Rules } from "../src/agent-permission-engine.js";
import { agentPermissionRulesForActions } from "../src/managed-desktop-policy.js";

const outside: AgentPermissionRule = { action: "external_directory", resource: "*", effect: "deny", source: "Contractors" };

describe("outside workspace permissions on OpenCode v2", () => {
  test("native denials ask so the plugin can explain the organization rule", () => {
    expect(agentPermissionEngineV2Rules([outside])).toEqual([{ action: "external_directory", resource: "*", effect: "ask" }]);
    expect(agentPermissionEngineV2Decision([outside], "external_directory", ["*"], "allow")).toEqual({
      effect: "deny", message: "Your organization's agent permissions block folders outside the workspace (set for Contractors).",
    });
  });
  test("ask stays ask even when the engine allows, and never weakens an engine denial", () => {
    const rule: AgentPermissionRule = { ...outside, effect: "ask" };
    expect(agentPermissionEngineV2Rules([rule])).toEqual([{ action: "external_directory", resource: "*", effect: "ask" }]);
    expect(agentPermissionEngineV2Decision([rule], "external_directory", ["/outside"], "allow")).toEqual({ effect: "ask" });
    expect(agentPermissionEngineV2Decision([rule], "external_directory", ["/outside"], "deny")).toEqual({ effect: "deny" });
  });
  test("without rules the engine decision is unchanged", () => {
    for (const effect of ["allow", "ask", "deny"] satisfies ("allow" | "ask" | "deny")[]) {
      expect(agentPermissionEngineV2Decision([], "external_directory", ["/outside"], effect)).toEqual({ effect });
    }
  });
  test("computer and scripting belong to the desktop, not the engine", () => {
    const rules: AgentPermissionRule[] = [{ ...outside, action: "computer" }, { ...outside, action: "script" }];
    expect(agentPermissionEngineV2Rules(rules)).toEqual([]);
    expect(agentPermissionEngineV2Decision(rules, "computer", ["*"], "allow")).toEqual({ effect: "allow" });
    expect(agentPermissionEngineV2Decision(rules, "script", ["*"], "allow")).toEqual({ effect: "allow" });
  });
});

test("desktop host rule filtering preserves ordered computer and script rules only", () => {
  const computer: AgentPermissionRule = { ...outside, action: "computer", effect: "ask" };
  const script: AgentPermissionRule = { ...outside, action: "script" };
  const website: AgentPermissionRule = { ...outside, action: "webfetch" };
  const rules = [outside, computer, website, script];
  expect(agentPermissionRulesForActions(rules, ["computer", "script"])).toEqual([computer, script]);
  expect(agentPermissionRulesForActions(rules, ["webfetch"])).toEqual([website]);
  expect(agentPermissionRulesForActions([], ["computer", "script"])).toEqual([]);
  expect(rules).toEqual([outside, computer, website, script]);
});
