import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildSkill, rulesOnly } from "../scripts/sync-ui-skills.mjs";

test("keeps rules and drops invocation and output-format sections, even with headings in code blocks", () => {
  const source = "---\nname: x\n---\n\n# Title\n\n## How to use\n\n- `/x <file>`\n\n## Rules\n\n- MUST label inputs\n\n## Output Format\n\n```text\n## src/a.tsx\nsrc/a.tsx:1 - bad\n```\n\nNo preamble.\n";
  const out = rulesOnly(source);
  assert.match(out, /### Title/);
  assert.match(out, /MUST label inputs/);
  assert.doesNotMatch(out, /How to use|\/x <file>|Output Format|src\/a\.tsx|No preamble/);
});

test("the generated skill carries every pin's source and hash", () => {
  const skill = buildSkill("---\nname: s\n---\n", [{ id: "a", source: "https://example.test/a", sha256: "f".repeat(64) }], { a: "- rule\n" });
  assert.match(skill, /### a\n\nSource: https:\/\/example\.test\/a \(sha256 ffffffffffff\)\n\n- rule\n$/);
});

test("the committed ui-skills-review skill matches its pins", () => {
  execFileSync("node", [new URL("../scripts/sync-ui-skills.mjs", import.meta.url).pathname, "--check"], { stdio: "pipe" });
  const sweep = readFileSync(new URL("../sweep.toml", import.meta.url), "utf8");
  assert.match(sweep, /name = "ui-skills-review"/);
});
