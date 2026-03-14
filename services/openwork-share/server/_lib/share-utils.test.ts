import test from "node:test";
import assert from "node:assert/strict";

import { buildBundlePreviewSelections } from "./share-utils.ts";
import type { NormalizedBundle } from "./types.ts";

test("buildBundlePreviewSelections slugifies shared skill filenames", () => {
  const selections = buildBundlePreviewSelections({
    schemaVersion: 1,
    type: "skill",
    name: "agent-creator",
    description: "",
    trigger: "",
    content: "# Agent Creator",
    workspace: null,
    skills: [],
    commands: [],
  });

  assert.equal(selections[0]?.filename, "agent-creator.md");
  assert.equal(selections[0]?.label, "Skill");
});

test("buildBundlePreviewSelections exposes workspace configs alongside skills", () => {
  const bundle: NormalizedBundle = {
    schemaVersion: 1,
    type: "workspace-profile",
    name: "Team Workspace",
    description: "",
    trigger: "",
    content: "",
    workspace: {
      skills: [{ name: "workspace-guide", description: "", trigger: "", content: "# Guide" }],
      commands: [{ name: "daily-sync", description: "", template: "# Daily Sync", content: "", agent: "planner", model: "", subtask: false }],
      openwork: { reload: { auto: true } },
      opencode: {
        agent: { concierge: { model: "openai/gpt-5.4" } },
        mcp: { github: { type: "remote" } },
        model: "openai/gpt-5.4",
      },
      config: {
        "team-rules.json": { strict: true },
      },
    },
    skills: [],
    commands: [],
  };

  const selections = buildBundlePreviewSelections(bundle);

  assert.deepEqual(
    selections.map((selection) => selection.filename),
    ["workspace-guide.md", "daily-sync.md", "concierge.json", "github.json", "opencode.json", "openwork.json", "team-rules.json"],
  );
  assert.equal(selections[4]?.label, "OpenCode settings");
  assert.equal(selections[5]?.label, "Workspace settings");
});
