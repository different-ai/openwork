import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPermissionEngineV2ToolHidden, type AgentPermissionRule } from "../src/agent-permission-engine.js";
import plugin from "../src/opencode-plugins/openwork-agent-permissions-v2.js";

function rule(action: AgentPermissionRule["action"], effect: AgentPermissionRule["effect"], resource = "*"): AgentPermissionRule {
  return { action, effect, resource, source: "Everyone" };
}

test("fully denied native tools are hidden, while organization connections and unrelated tools stay available", () => {
  const rules = [rule("websearch", "deny")];
  assert.equal(agentPermissionEngineV2ToolHidden(rules, "websearch"), true);
  for (const id of ["webfetch", "read", "shell", "search", "execute", "openwork-cloud_search_capabilities", "exa_websearch"]) {
    assert.equal(agentPermissionEngineV2ToolHidden(rules, id), false, id);
  }
  for (const [action, tools] of [
    ["shell", ["shell"]], ["edit", ["edit", "write", "patch", "opencode_worktree_remove"]],
    ["webfetch", ["webfetch"]], ["skill", ["skill"]],
  ] as const) {
    for (const tool of tools) assert.equal(agentPermissionEngineV2ToolHidden([rule(action, "deny")], tool), true, tool);
  }
});

test("partial blocks, approvals and allow exceptions keep the tool available", () => {
  for (const rules of [
    [], [rule("shell", "allow")], [rule("shell", "ask")], [rule("shell", "deny", "rm *")],
    [rule("shell", "deny"), rule("shell", "allow", "echo *")],
    [rule("shell", "deny"), rule("shell", "ask", "echo *")],
    [rule("shell", "deny"), rule("shell", "allow")],
  ]) assert.equal(agentPermissionEngineV2ToolHidden(rules, "shell"), false, JSON.stringify(rules));
  assert.equal(agentPermissionEngineV2ToolHidden([
    rule("webfetch", "deny"), rule("webfetch", "allow", "example.com"), rule("webfetch", "deny", "private.example.com"),
  ], "webfetch"), false);
});

test("a final whole-action denial supersedes earlier exceptions", () => {
  assert.equal(agentPermissionEngineV2ToolHidden([
    rule("shell", "deny"), rule("shell", "allow", "echo *"), rule("shell", "deny"),
  ], "shell"), true);
  assert.equal(agentPermissionEngineV2ToolHidden([
    rule("websearch", "deny"), rule("shell", "allow"),
  ], "websearch"), true);
});

test("the plugin filters the replayed catalog and still enforces denied calls from older snapshots", async () => {
  const ids = ["websearch", "shell", "read", "openwork-cloud_search_capabilities", "exa_websearch"];
  const available = new Set(ids);
  type Context = Parameters<typeof plugin.setup>[0];
  let transform: Parameters<Context["tool"]["transform"]>[0] | undefined;
  let evaluate: Parameters<Context["permission"]["hook"]>[1] | undefined;
  const registration = { async dispose() {} };
  const replay = () => {
    available.clear();
    for (const id of ids) available.add(id);
    transform?.({ list: () => [...available].map(id => ({ id })), remove: id => { available.delete(id); } });
  };
  const dispose = await plugin.setup({
    options: { rules: [rule("websearch", "deny"), rule("shell", "deny", "rm *")] },
    tool: {
      async transform(callback) {
        transform = callback;
        replay();
        return { async dispose() { transform = undefined; replay(); } };
      },
      async hook() { return registration; },
    },
    permission: { async hook(_name, callback) { evaluate = callback; return registration; } },
    mcp: { async transform() { return registration; } },
  });
  assert.deepEqual([...available], ids.filter(id => id !== "websearch"));
  // Catalog refreshes replay the filter instead of putting the hidden tool back.
  replay();
  assert.equal(available.has("websearch"), false);
  const event: Parameters<NonNullable<typeof evaluate>>[0] = { action: "websearch", resources: ["current news"], effect: "allow" };
  assert.ok(evaluate);
  evaluate(event);
  assert.equal(event.effect, "deny");
  assert.match(event.message ?? "", /block searching the web/);
  const partial: typeof event = { action: "shell", resources: ["rm notes.txt"], effect: "allow" };
  evaluate(partial);
  assert.equal(partial.effect, "deny");
  const allowed: typeof event = { action: "shell", resources: ["echo hello"], effect: "allow" };
  evaluate(allowed);
  assert.equal(allowed.effect, "allow");
  await dispose();
  assert.deepEqual([...available], ids, "unloading the policy restores the catalog");
});
