import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenWorkV2Instructions, readConfiguredInstructions } from "../src/opencode-v2-instructions.js";

test("V2 instructions support both individual Connect tools and capability search", () => {
  const instructions = buildOpenWorkV2Instructions(true);
  for (const text of [instructions.operatingInstructions, instructions.connect]) {
    assert.match(text, /search\(\) to discover available tools/);
    assert.match(text, /individual service tools, call them directly/);
    assert.match(text, /When it exposes search_capabilities and execute_capability instead/);
    assert.doesNotMatch(text, /bare search\(\) function only for other/);
    assert.doesNotMatch(text, /discover services and Workflows with openwork-cloud\.search_capabilities/);
  }
});

test("V2 Desktop instructions direct recurring work to a reviewable proposal", () => {
  const instructions = buildOpenWorkV2Instructions(true);
  assert.match(instructions.automations, /openwork_execute id automation\.propose/);
  assert.match(instructions.automations, /review and create it in the app/);
  assert.match(instructions.automations, /each occurrence requires the signed-in desktop runner/);
  assert.match(instructions.automations, /never claim a Desktop Automation will run while the app is offline/);
});

test("V2 instructions do not claim Connect is available when disconnected", () => {
  assert.equal(buildOpenWorkV2Instructions(false).connect,
    "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.");
});

test("configured instructions load workspace files the engine skips", async () => {
  const base = await mkdtemp(join(tmpdir(), "openwork-configured-instructions-"));
  try {
    const workspace = join(base, "workspace");
    await mkdir(join(workspace, ".opencode"), { recursive: true });
    await mkdir(join(workspace, "rules"));
    await writeFile(join(base, "outside.md"), "outside rules");
    await writeFile(join(workspace, ".opencode", "AGENTS.md"), "project rules");
    await writeFile(join(workspace, "rules", "b.md"), "rule b");
    await writeFile(join(workspace, "rules", "a.md"), "rule a");
    await symlink(join(base, "outside.md"), join(workspace, "rules", "c.md"));
    await writeFile(join(workspace, "opencode.jsonc"), `{
      // Same file twice, a glob, paths outside the workspace and a URL.
      "instructions": [".opencode/AGENTS.md", "rules/*.md", "../outside.md", "${join(base, "outside.md")}", "https://example.com/rules.md"],
    }`);
    await writeFile(join(workspace, ".opencode", "opencode.json"), JSON.stringify({ instructions: [".opencode/AGENTS.md"] }));

    assert.equal(await readConfiguredInstructions(workspace), [
      `Instructions from: ${join(workspace, ".opencode", "AGENTS.md")}\nproject rules`,
      `Instructions from: ${join(workspace, "rules", "a.md")}\nrule a`,
      `Instructions from: ${join(workspace, "rules", "b.md")}\nrule b`,
    ].join("\n\n"));

    await writeFile(join(workspace, "opencode.jsonc"), "{}");
    await rm(join(workspace, ".opencode", "opencode.json"));
    assert.equal(await readConfiguredInstructions(workspace), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("configured instructions never send local or secret files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "openwork-configured-instructions-git-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    await mkdir(join(workspace, "rules"));
    await writeFile(join(workspace, ".gitignore"), "private.md\n");
    await writeFile(join(workspace, "CONTRIBUTING.md"), "shared rules");
    await writeFile(join(workspace, "private.md"), "ignored notes");
    await writeFile(join(workspace, ".env"), "TOKEN=secret");
    await writeFile(join(workspace, "deploy.env.md"), "TOKEN=secret");
    await writeFile(join(workspace, "credentials.json"), "{\"token\":\"secret\"}");
    await symlink(join(workspace, ".env"), join(workspace, "rules", "env.md"));
    await symlink(join(workspace, "private.md"), join(workspace, "rules", "private-link.md"));
    await writeFile(join(workspace, "opencode.json"), JSON.stringify({
      instructions: ["CONTRIBUTING.md", "private.md", ".env", "deploy.env.md", "credentials.json", "rules/*.md"],
    }));

    assert.equal(await readConfiguredInstructions(workspace), `Instructions from: ${join(workspace, "CONTRIBUTING.md")}\nshared rules`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
