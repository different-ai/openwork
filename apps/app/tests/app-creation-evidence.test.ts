import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { appCreationFailures, appCreationProgress, appCreationRuns, foldedAppCreationPartIds } from "../src/react-app/domains/apps/app-creation-progress";
import { getCapabilityCallSentence } from "../src/lib/capability-call";
import { skillEvidence } from "../src/lib/skill-evidence";

const guide: DynamicToolUIPart = { type: "dynamic-tool", toolCallId: "guide", toolName: "openwork-cloud_get_skill", input: { name: "build-an-app" }, state: "output-error", errorText: "Instructions unavailable" };
function messages(...parts: DynamicToolUIPart[]): UIMessage[] { return [{ id: "assistant", role: "assistant", parts }]; }

test("a failed guide remains a failed App intent after the turn and reload", () => {
  const [live] = appCreationRuns(messages(guide), true);
  expect(appCreationProgress(live!, true)).toMatchObject({ failed: true, running: false });
  const [saved] = appCreationRuns(JSON.parse(JSON.stringify(messages(guide))), false);
  expect(appCreationProgress(saved!, false)).toMatchObject({ failed: true, running: false });
  expect(appCreationFailures(saved!)).toHaveLength(1);
});

test("a failed App read never becomes a successful editing stage", () => {
  const read: DynamicToolUIPart = { ...guide, toolName: "openwork-cloud_read_app", input: { appId: "app" } };
  const [run] = appCreationRuns(messages(read), true);
  expect(appCreationProgress(run!, true)).toMatchObject({ failed: true, running: false });
});

test("only a successful guide retrieval resolves its failure", () => {
  const retry: DynamicToolUIPart = { type: "dynamic-tool", toolName: guide.toolName, input: guide.input, toolCallId: "retry", state: "output-available", output: { content: "This is discovery metadata, NOT the skill's instructions or proof of access." } };
  const [metadata] = appCreationRuns(messages(guide, retry), true);
  expect(appCreationFailures(metadata!)).toHaveLength(1);
  const loaded: DynamicToolUIPart = { type: "dynamic-tool", toolName: guide.toolName, input: guide.input, toolCallId: "retry", state: "output-available", output: { content: "---\nname: build-an-app\n---\nBuild the requested App." } };
  const [success] = appCreationRuns(messages(guide, loaded), true);
  expect(appCreationFailures(success!)).toHaveLength(0);
});

test("an unrelated successful script does not resolve a failed guide script", () => {
  const failed: DynamicToolUIPart = { ...guide, toolName: "execute", callProviderMetadata: { openwork: { codeMode: { calls: [{ tool: "openwork.get_skill", input: { name: "build-an-app" }, status: "error" }] } } } };
  const unrelated: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "other", input: { code: "await tools.openwork.prepare_app({})" }, state: "output-available", output: "Done", callProviderMetadata: { openwork: { codeMode: { calls: [{ tool: "openwork.search_capabilities", input: {}, status: "completed" }] } } } };
  const [run] = appCreationRuns(messages(failed, unrelated), true);
  expect(appCreationFailures(run!)).toHaveLength(1);
});

test("a script error is not swallowed by its successful App stage", () => {
  const script: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script", state: "output-error", input: { code: "create_app(); throw Error()" }, errorText: "Later script failure",
    callProviderMetadata: { openwork: { codeMode: { calls: [{ tool: "openwork-cloud.create_app", status: "completed", input: {} }] } } } };
  const app: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_create_app", toolCallId: "script:app:openwork-cloud_create_app:0", state: "output-available", input: {}, output: { unrecorded: true }, callProviderMetadata: { openwork: { mcpResult: { structuredContent: { unrecorded: true } } } } };
  const runs = appCreationRuns(messages(script, app));
  const folded = foldedAppCreationPartIds(runs);
  expect(folded.has(app.toolCallId)).toBe(true);
  expect(folded.has(script.toolCallId)).toBe(false);
});

describe("skill delivery evidence", () => {
  const native: DynamicToolUIPart = { type: "dynamic-tool", toolName: "skill", toolCallId: "skill", input: { name: "review" }, state: "input-available" };
  test("selection, metadata, blocked setup, and delivered instructions are distinct", () => {
    expect(skillEvidence(native)?.state).toBe("selected");
    expect(skillEvidence({ ...native, state: "output-available", output: undefined })?.state).toBe("metadata-only");
    const blocked: DynamicToolUIPart = { ...native, state: "output-available", output: "This organization skill is not ready yet. Its instructions are withheld until it is set up." };
    expect(skillEvidence(blocked)?.state).toBe("blocked");
    expect(getCapabilityCallSentence(blocked).past).toContain("instructions unavailable");
    const loaded: DynamicToolUIPart = { ...native, state: "output-available", output: "<skill_content name=\"review\">Review the report.</skill_content>" };
    expect(skillEvidence(loaded)?.state).toBe("instructions-loaded");
    expect(getCapabilityCallSentence(loaded).past).toBe("Loaded “review” instructions");
    expect(getCapabilityCallSentence(loaded).past).not.toMatch(/Used|Using/);
  });
  test("tab-heavy frontmatter is parsed without a backtracking name expression", () => {
    const output = `---\nname:${"\t".repeat(100_000)}\n---\nRead the report.`;
    const found = skillEvidence({ ...native, toolName: "openwork_get_skill", state: "output-available", output });
    expect(found?.name).toBe("review");
    expect(found?.state).toBe("metadata-only");
  });
  test("a successful status with only an acknowledgement does not attest instructions", () => {
    expect(skillEvidence({ ...native, toolName: "openwork_get_skill", state: "output-available", output: "Skill selected" })?.state).toBe("metadata-only");
  });
  test("a bounded delivery receipt survives truncated diagnostic output", () => {
    const loaded: DynamicToolUIPart = { ...native, state: "output-available", output: "[Result truncated by OpenWork]", callProviderMetadata: { openwork: { skillDelivery: { name: "review", state: "instructions-loaded" } } } };
    expect(skillEvidence(loaded)?.state).toBe("instructions-loaded");
    expect(skillEvidence({ ...loaded, callProviderMetadata: undefined })?.state).toBe("metadata-only");
  });
  test("a skill capability also reports retrieval, not application", () => {
    const loaded: DynamicToolUIPart = { ...native, toolName: "openwork_execute_capability", input: { name: "skill:review" }, state: "output-available", output: { kind: "skill", name: "review", content: "Check the report." } };
    expect(getCapabilityCallSentence(loaded).past).toBe("Loaded “review” instructions");
  });
  test("a file named SKILL.md is not proof a skill was applied", () => {
    expect(skillEvidence({ ...native, toolName: "read", input: { filePath: "/work/SKILL.md" }, state: "output-available", output: "---\nname: review\n---\nReview" })).toBeNull();
  });
});
