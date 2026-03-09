import test from "node:test";
import assert from "node:assert/strict";

import { packageOpenworkFiles } from "./package-openwork-files.js";

test("packageOpenworkFiles creates a single skill bundle from skill markdown", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: ".opencode/skills/sales-inbound/SKILL.md",
        content: `---
name: sales-inbound
description: Handle inbound sales leads.
trigger: crm
version: 1.2.0
---

# Sales Inbound

Route fresh leads and qualify them.`,
      },
    ],
  });

  assert.equal(result.bundleType, "skill");
  assert.equal(result.bundle.type, "skill");
  assert.equal(result.bundle.name, "sales-inbound");
  assert.equal(result.bundle.trigger, "crm");
  assert.equal(result.summary.skills, 1);
  assert.equal(result.items[0]?.kind, "Skill");
});

test("packageOpenworkFiles builds a workspace profile with agents and MCP config", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: ".opencode/agents/sales-inbound.md",
        content: `---
description: Handles inbound sales work.
mode: subagent
model: openai/gpt-5.4
version: 1.2.0
---

You qualify leads and route follow-up.`,
      },
      {
        path: "opencode.jsonc",
        content: `{
          // Only the mcp section should be exported
          "mcp": {
            "crm-sync": {
              "type": "remote",
              "url": "https://crm.example.com/mcp"
            }
          },
          "provider": {
            "openai": {
              "apiKey": "should-not-leak"
            }
          }
        }`,
      },
    ],
  });

  assert.equal(result.bundleType, "workspace-profile");
  assert.equal(result.bundle.type, "workspace-profile");
  assert.equal(result.summary.agents, 1);
  assert.equal(result.summary.mcpServers, 1);
  assert.deepEqual(Object.keys(result.bundle.workspace.opencode.agent), ["sales-inbound"]);
  assert.deepEqual(Object.keys(result.bundle.workspace.opencode.mcp), ["crm-sync"]);
  assert.equal(result.bundle.workspace.opencode.provider, undefined);
});

test("packageOpenworkFiles rejects secret-looking MCP config values", () => {
  assert.throws(
    () =>
      packageOpenworkFiles({
        files: [
          {
            path: "opencode.json",
            content: JSON.stringify({
              mcp: {
                crm: {
                  type: "remote",
                  headers: {
                    Authorization: "Bearer real-secret-token",
                  },
                },
              },
            }),
          },
        ],
      }),
    /Potential secrets found/,
  );
});
