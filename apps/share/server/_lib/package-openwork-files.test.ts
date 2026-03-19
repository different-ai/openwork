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

test("packageOpenworkFiles accepts any single text file when frontmatter has name and description", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: "AGENTS.md",
        content: `---
name: agent-creator
description: Create new OpenCode agents with a gpt-5.2-codex default.
---

# Agent Creator

Any markdown body is acceptable here.
`,
      },
    ],
  });

  assert.equal(result.bundleType, "skill");
  assert.equal(result.bundle.type, "skill");
  assert.equal(result.bundle.name, "agent-creator");
  assert.equal(result.items[0]?.name, "agent-creator");
});

test("packageOpenworkFiles rejects content without name and description frontmatter", () => {
  assert.throws(
    () =>
      packageOpenworkFiles({
        files: [
          {
            path: "whatever.txt",
            content: `# Revenue Agent

Handles inbound lead routing.`,
          },
        ],
      }),
    /name and description/i,
  );
});

test("packageOpenworkFiles rejects multiple uploaded files", () => {
  assert.throws(
    () =>
      packageOpenworkFiles({
        files: [
          {
            path: "SKILL.md",
            content: `# Detect Instructions

Identity: inspect copied prompts.

## Trigger

Runs when a prompt needs cleanup.`,
          },
          {
            path: "notes.md",
            content: "Extra text",
          },
        ],
      }),
    /single skill/i,
  );
});

test("packageOpenworkFiles rejects config json uploads", () => {
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
                  url: "https://mcp.example.com",
                },
              },
            }),
          },
        ],
    }),
    /name and description/i,
  );
});

test("packageOpenworkFiles rejects agent and config combinations", () => {
  assert.throws(
    () =>
      packageOpenworkFiles({
        files: [
          {
            path: ".opencode/agents/sales-inbound.md",
            content: `---
description: Handles inbound sales work.
mode: subagent
model: openai/gpt-5.4
---

You qualify leads and route follow-up.`,
          },
          {
            path: "opencode.jsonc",
            content: `{
              "model": "openai/gpt-5.4"
            }`,
          },
        ],
      }),
    /single skill/i,
  );
});
