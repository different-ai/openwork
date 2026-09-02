import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { OPENWORK_AGENT_PROMPT } from "../../apps/server/src/openwork-agent-prompt";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { OpenWorkCapabilitiesKnowledge } from "../../apps/server/src/opencode-plugins/openwork-capabilities-knowledge";
import {
  OPENWORK_CLOUD_CONNECTION_INSTRUCTION,
  OPENWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION,
} from "../../apps/server/src/opencode-plugins/openwork-extensions-preview-steering";
import { renderOpenWorkConnectSkillInstruction } from "../../apps/server/src/connect-skill-catalog";
import {
  readOpenworkRuntimeFacts,
  renderOpenworkRuntimeContext,
} from "../../apps/app/src/react-app/domains/session/sync/runtime-context";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function composeReadyPrompt(): Promise<string[]> {
  const engineMcp = {
    async status() {
      return { data: { "openwork-cloud": { status: "connected" } } };
    },
  };
  const extensions = await OpenWorkExtensionsPreview({ client: { mcp: engineMcp }, directory: "/tmp/spec" });
  const knowledge = await OpenWorkCapabilitiesKnowledge();
  // The engine joins the agent prompt with its own env, instruction, MCP, and
  // skill entries into one header before the hooks run; the base prompt stands
  // in for that header here. Hooks run in runtime-config registration order.
  const output: { system: string[] } = { system: [OPENWORK_AGENT_PROMPT] };
  await knowledge["experimental.chat.system.transform"]({}, output);
  await extensions["experimental.chat.system.transform"]({}, output);
  return output.system;
}

test("the composed OpenWork system prompt is single, deduplicated, ordered, current, and carries the user's time zone", async ({ evidence }) => {
  const system = await composeReadyPrompt();

  // Claim 1: the request still carries exactly one system message (the shape
  // introduced for OpenAI-compatible chat templates), with the base prompt
  // first and the OpenWork sections separated by blank lines.
  expect(system).toHaveLength(1);
  const prompt = system[0];
  expect(prompt.startsWith("You are OpenWork.")).toBe(true);
  expect(prompt).toContain("\n\nYou are running inside OpenWork.");
  expect(prompt).toContain("\n\n## OpenWork app context");
  expect(prompt).toContain("\n\n## Built-in Browser (external websites)");
  expect(prompt).toContain(`\n\n${OPENWORK_CLOUD_CONNECTION_INSTRUCTION}`);
  evidence.recordAssertionEvidence(
    "One system message, blank-line separated",
    "Running both transform hooks on the base prompt leaves the engine system array at length 1; the base prompt is first and every OpenWork section starts its own paragraph.",
    true,
  );

  // Claim 2: Den removed the Memory Bank (writes return 410 and the routes left
  // the MCP catalog), so no part of the prompt may still teach it, and every
  // docs pointer must be a path openwork_docs_read can actually resolve.
  expect(prompt).not.toContain("Memory Bank");
  expect(prompt).not.toContain("postMemory");
  expect(prompt).not.toContain("getMemorySearch");
  expect(prompt).not.toContain("deleteMemoryById");
  expect(prompt).not.toContain("packages/docs/");
  expect(prompt).toContain("read cloud/run-in-the-cloud/cloud-mcp.mdx with openwork_docs_read");
  expect(prompt).toContain("read cloud/share-with-your-team/desktop-policies.mdx");
  evidence.recordAssertionEvidence(
    "No removed feature and no unreadable docs pointer",
    "The composed prompt contains no Memory Bank guidance or memory capability names, and every openwork_docs_read pointer is docs-relative rather than prefixed with packages/docs/.",
    true,
  );

  // Claim 3: each operating rule has exactly one owner; the former
  // restatements are gone, not merely reduced.
  expect(occurrences(prompt, "only name services that search or the remote skill catalog actually returns")).toBe(1);
  expect(occurrences(OPENWORK_AGENT_PROMPT, "openwork-cloud_search_capabilities")).toBe(1);
  expect(prompt).not.toContain("2-4 keyword variants");
  expect(prompt).not.toContain("A successful search proves");
  expect(occurrences(prompt, OPENWORK_CLOUD_CONNECTION_INSTRUCTION)).toBe(1);
  expect(prompt).not.toContain("require the user to sign in to OpenWork first");
  expect(occurrences(prompt, OPENWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION)).toBe(1);
  expect(prompt).not.toContain("retrieve the listed remote `create-skill` skill");
  expect(prompt).not.toContain("factor them into a skill");
  expect(occurrences(prompt, "never browser_* tools for the OpenWork app itself")).toBe(1);
  expect(prompt).not.toContain("NOT browser tools");
  expect(prompt).not.toContain("Never use browser_* tools on the OpenWork app itself");
  expect(occurrences(prompt, "session.search then session.read")).toBe(1);
  expect(prompt).not.toContain("open the matching session");
  expect(occurrences(prompt, "as the first source of truth")).toBe(1);
  expect(prompt).not.toContain("Important docs to know");
  expect(prompt).not.toContain("from an actual capability call");
  evidence.recordAssertionEvidence(
    "One owner per rule",
    "Connect mechanics, readiness, skill-authoring mode, the browser/app boundary, other-session reads, docs-first guidance, and the Automation read-live rule each occur exactly once in the composed prompt, and their former restatements are absent.",
    true,
  );

  // Claim 4: the agent reads how to operate before live steering, and live
  // steering before the data catalogs it governs.
  const knowledgeAt = prompt.indexOf("You are running inside OpenWork.");
  const appContextAt = prompt.indexOf("## OpenWork app context");
  const browserAt = prompt.indexOf("## Built-in Browser (external websites)");
  const steeringAt = prompt.indexOf(OPENWORK_CLOUD_CONNECTION_INSTRUCTION);
  const skillAuthoringAt = prompt.indexOf(OPENWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION);
  expect(knowledgeAt).toBeGreaterThan(0);
  expect(appContextAt).toBeGreaterThan(knowledgeAt);
  expect(browserAt).toBeGreaterThan(appContextAt);
  expect(steeringAt).toBeGreaterThan(browserAt);
  expect(skillAuthoringAt).toBeGreaterThan(steeringAt);
  evidence.recordAssertionEvidence(
    "Rules precede state precede catalogs",
    "The base prompt is first, the knowledge block precedes the app-context and browser mechanics, those precede the live Connect steering, which precedes the skill-authoring mode that the catalogs follow.",
    true,
  );

  // Claim 5: remote skills no longer share the engine's <available_skills>
  // tag, and each skill costs one line on every request.
  const catalog = renderOpenWorkConnectSkillInstruction([
    {
      name: "customer-briefing",
      type: "skill-md",
      title: "Customer Briefing",
      description: "Use for accounts & renewals",
      marketplaceName: "Revenue",
      pluginName: "Customer Ops",
      url: "skill://customer-briefing/SKILL.md",
      capability: "skill:skill_customer_briefing",
    },
    {
      name: "legacy-skill",
      type: "skill-md",
      description: "",
      url: "skill://legacy-skill/SKILL.md",
      capability: "skill:skill_legacy",
    },
  ]);
  expect(catalog).toContain("<available_remote_skills>");
  expect(catalog).not.toContain("<available_skills>");
  expect(catalog).toContain(
    '  <skill name="customer-briefing" capability="skill:skill_customer_briefing" source="Revenue / Customer Ops">Customer Briefing: Use for accounts &amp; renewals</skill>',
  );
  expect(catalog).toContain('  <skill name="legacy-skill" capability="skill:skill_legacy">legacy-skill</skill>');
  expect(catalog.match(/^  <skill /gm)).toHaveLength(2);
  expect(catalog).not.toContain("skill://");
  evidence.recordAssertionEvidence(
    "Remote skills render as <available_remote_skills>, one line per skill",
    "The rendered catalog uses the distinct block name, one <skill> line per entry carrying name, capability, and source attributes with the title and description as text, and never leaks the skill:// URL.",
    true,
  );

  // Claim 6: at 2026-09-02T02:38Z it is still Tuesday September 1 in Los
  // Angeles; the app's user context must say so, and must not embed the
  // minute, which would invalidate the provider prompt cache on every turn.
  const instant = new Date("2026-09-02T02:38:00Z");
  const pacific = renderOpenworkRuntimeContext(readOpenworkRuntimeFacts({
    now: instant,
    timeZone: "America/Los_Angeles",
    locale: "en-US",
  }));
  const utc = renderOpenworkRuntimeContext(readOpenworkRuntimeFacts({ now: instant, timeZone: "UTC", locale: "en-US" }));
  expect(pacific).toContain("- Time zone: America/Los_Angeles (UTC-07:00)");
  expect(pacific).toContain("- Today's date in that time zone: Tuesday 2026-09-01");
  expect(pacific).toContain("- Locale: en-US");
  expect(pacific).toContain("Resolve \"today\", \"tomorrow\", \"this week\"");
  expect(pacific).not.toContain("02:38");
  expect(pacific).not.toContain("19:38");
  expect(utc).toContain("- Today's date in that time zone: Wednesday 2026-09-02");
  evidence.recordAssertionEvidence(
    "User context states the person's zone and local date, not the host's",
    "For 2026-09-02T02:38Z the America/Los_Angeles context renders Tuesday 2026-09-01 with UTC-07:00 and the relative-date rule while omitting the time of day; the UTC rendering of the same instant is Wednesday 2026-09-02.",
    true,
  );

  // Claim 7: the agent-prompt-markers diagnostic keys on the Connect tool
  // names and the Artifacts section; the canonical prompt satisfies all three
  // so Settings > Debug stays green.
  expect(OPENWORK_AGENT_PROMPT).toContain("search_capabilities");
  expect(OPENWORK_AGENT_PROMPT).toContain("execute_capability");
  expect(OPENWORK_AGENT_PROMPT).toContain("## OpenWork Artifacts");
  evidence.recordAssertionEvidence(
    "Canonical prompt satisfies the diagnostics markers",
    "The base agent prompt contains search_capabilities, execute_capability, and the ## OpenWork Artifacts heading that the agent-prompt-markers check requires.",
    true,
  );
});
