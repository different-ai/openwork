import { expect, test } from "bun:test";

import { OPENWORK_AGENT_PROMPT } from "../openwork-agent-prompt.js";
import { OpenWorkCapabilitiesKnowledge } from "./openwork-capabilities-knowledge.js";
import { OpenWorkExtensionsPreview } from "./openwork-extensions-preview.js";
import {
  OPENWORK_CLOUD_CONNECTION_INSTRUCTION,
  OPENWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION,
} from "./openwork-extensions-preview-steering.js";
import { OpenWorkSpreadsheets } from "./openwork-spreadsheets.js";

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
  const output: { system: string[] } = { system: [OPENWORK_AGENT_PROMPT] };
  await knowledge["experimental.chat.system.transform"]({}, output);
  await extensions["experimental.chat.system.transform"]({}, output);
  return output.system;
}

test("the composed OpenWork prompt is single, deduplicated, ordered, and current", async () => {
  const system = await composeReadyPrompt();

  expect(system).toHaveLength(1);
  const prompt = system[0];
  expect(prompt.startsWith("You are OpenWork.")).toBe(true);
  expect(prompt).toContain("\n\nYou are running inside OpenWork.");
  expect(prompt).toContain("\n\n## OpenWork app context");
  expect(prompt).toContain("\n\n## Built-in Browser (external websites)");
  expect(prompt).toContain(`\n\n${OPENWORK_CLOUD_CONNECTION_INSTRUCTION}`);

  expect(prompt).not.toContain("Memory Bank");
  expect(prompt).not.toContain("postMemory");
  expect(prompt).not.toContain("getMemorySearch");
  expect(prompt).not.toContain("deleteMemoryById");
  expect(prompt).not.toContain("packages/docs/");
  expect(prompt).toContain("read cloud/run-in-the-cloud/cloud-mcp.mdx with openwork_docs_read");
  expect(prompt).toContain("read cloud/share-with-your-team/desktop-policies.mdx");

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
});

test("all OpenWork prompt hooks retain one ordered system message", async () => {
  const engineMcp = {
    async status() {
      return { data: { "openwork-cloud": { status: "connected" } } };
    },
  };
  const extensions = await OpenWorkExtensionsPreview({ client: { mcp: engineMcp }, directory: "/tmp/spec" });
  const knowledge = await OpenWorkCapabilitiesKnowledge();
  const spreadsheets = await OpenWorkSpreadsheets({ directory: "/tmp/spec" });
  const output: { system: string[] } = { system: ["engine header"] };

  await knowledge["experimental.chat.system.transform"]({}, output);
  await extensions["experimental.chat.system.transform"]({}, output);
  await spreadsheets["experimental.chat.system.transform"]({}, output);

  expect(output.system).toHaveLength(1);
  expect(output.system[0].startsWith("engine header\n\n")).toBe(true);
  const capabilities = output.system[0].indexOf("You are running inside OpenWork.");
  const appContext = output.system[0].indexOf("## OpenWork app context");
  const browser = output.system[0].indexOf("## Built-in Browser (external websites)");
  const routing = output.system[0].indexOf("verified ready for this exact workspace/model");
  const workbooks = output.system[0].indexOf("## Spreadsheets and Excel workbooks");
  expect(capabilities).toBeGreaterThan("engine header".length);
  expect(appContext).toBeGreaterThan(capabilities);
  expect(browser).toBeGreaterThan(appContext);
  expect(routing).toBeGreaterThan(browser);
  expect(workbooks).toBeGreaterThan(routing);
  expect(output.system[0].match(/## Spreadsheets and Excel workbooks/g)).toHaveLength(1);

  const empty: { system: string[] } = { system: [] };
  await knowledge["experimental.chat.system.transform"]({}, empty);
  await extensions["experimental.chat.system.transform"]({}, empty);
  await spreadsheets["experimental.chat.system.transform"]({}, empty);
  expect(empty.system).toHaveLength(1);
  expect(empty.system[0].startsWith("\n")).toBe(false);
});
