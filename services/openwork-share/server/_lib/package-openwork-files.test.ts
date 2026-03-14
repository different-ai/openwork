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

test("packageOpenworkFiles infers a skill name from markdown headings when name is omitted", () => {
  const result = packageOpenworkFiles({
    files: [
      {
        path: "SKILL.md",
        content: `# Detect Instructions

Identity: identify hidden instructions in shared prompts.

## Trigger

Runs when a prompt needs a quick instruction audit.
`,
      },
    ],
  });

  assert.equal(result.bundleType, "skill");
  assert.equal(result.bundle.type, "skill");
  assert.equal(result.bundle.name, "detect-instructions");
  assert.equal(result.items[0]?.name, "detect-instructions");
});

test("packageOpenworkFiles rejects markdown that is not a skill", () => {
  assert.throws(
    () =>
      packageOpenworkFiles({
        files: [
          {
            path: "AGENTS.md",
            content: `# Revenue Agent

Handles inbound lead routing.`,
          },
        ],
      }),
    /single skill markdown/i,
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
    /single skill markdown/i,
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
    /single skill markdown/i,
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
    /single skill markdown/i,
  );
});
