import test from "node:test";
import assert from "node:assert/strict";

import { packageOpenworkFiles } from "./package-openwork-files.ts";

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

test("packageOpenworkFiles rewrites shared skill frontmatter to the normalized bundle name", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: ".opencode/skills/sales-inbound/SKILL.md",
        content: `---
name: Sales Inbound
description: Handle inbound sales leads.
---

# Sales Inbound

Route fresh leads and qualify them.`,
      },
    ],
  });

  assert.equal(result.bundleType, "skill");
  assert.equal(result.bundle.name, "sales-inbound");
  assert.match((result.bundle as { content: string }).content, /^---\nname: sales-inbound\n/m);
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
          // Project config should survive alongside typed entries
          "model": "openai/gpt-5.4",
          "mcp": {
            "crm-sync": {
              "type": "remote",
              "url": "https://crm.example.com/mcp"
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
  assert.equal(result.summary.configs, 1);
  const workspace = result.bundle.workspace as Record<string, Record<string, Record<string, unknown>>>;
  assert.deepEqual(Object.keys(workspace.opencode.agent), ["sales-inbound"]);
  assert.deepEqual(Object.keys(workspace.opencode.mcp), ["crm-sync"]);
  assert.equal(workspace.opencode.model, "openai/gpt-5.4");
});

test("packageOpenworkFiles redacts secret-looking values and adds a warning", () => {
  const result = packageOpenworkFiles({
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
  });
  assert.ok(result.warnings.some((w) => /[Rr]edacted/.test(w)));
});

test("packageOpenworkFiles infers AGENTS.md as agent markdown", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: "AGENTS.md",
        content: `# Revenue Agent

## Agent overview

This agent handles inbound revenue operations.
The agent coordinates follow-up and handoff.`,
      },
    ],
  });

  assert.equal(result.bundleType, "workspace-profile");
  assert.equal(result.summary.agents, 1);
  assert.equal(result.items[0]?.kind, "Agent");
});

test("packageOpenworkFiles accepts mcp_config.json by filename as MCP config", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: "mcp_config.json",
        content: JSON.stringify({
          type: "remote",
          url: "https://mcp.example.com",
        }),
      },
    ],
  });

  assert.equal(result.bundleType, "workspace-profile");
  assert.equal(result.summary.mcpServers, 1);
  assert.equal(result.items[0]?.kind, "MCP");
});

test("packageOpenworkFiles accepts opencode-shaped jsonc from a generic filename", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: "workspace-config.jsonc",
        content: `{
          "$schema": "https://opencode.ai/config.json",
          "model": "anthropic/claude-sonnet-4-5",
          "autoupdate": true,
          "server": {
            "port": 4096
          }
        }`,
      },
    ],
  });

  assert.equal(result.bundleType, "workspace-profile");
  assert.equal(result.summary.configs, 1);
  const workspace = result.bundle.workspace as Record<string, Record<string, unknown>>;
  assert.equal(workspace.opencode.model, "anthropic/claude-sonnet-4-5");
  assert.equal(result.items[0]?.kind, "Config");
  assert.equal(result.items[0]?.meta, "OpenCode config");
});

test("packageOpenworkFiles falls back to generic config for unknown json objects", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: "settings.json",
        content: JSON.stringify({
          featureFlags: {
            experimentalShare: true,
          },
        }),
      },
    ],
  });

  assert.equal(result.bundleType, "workspace-profile");
  assert.equal(result.summary.configs, 1);
  const workspace = result.bundle.workspace as Record<string, Record<string, Record<string, unknown>>>;
  assert.equal(workspace.config.settings.featureFlags.experimentalShare, true);
  assert.equal(result.items[0]?.kind, "Config");
  assert.equal(result.items[0]?.meta, "Config file");
});
