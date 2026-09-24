import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";

import { getCapabilityCallQuote, getCapabilityCallSentence } from "@/lib/capability-call";

function executeCapability(input: unknown): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: "call_test",
    state: "output-error",
    input,
    errorText: "boom",
  };
}

describe("capability call sentences", () => {
  test.each(["openwork_execute_capability", "openwork-cloud_execute_capability"])("names exact connection probes from %s", (toolName) => {
    const part = { ...executeCapability({ name: "mcp:emc_probe:*", query: "ignored" }), toolName };
    expect(getCapabilityCallSentence(part, { connectionName: "Notion" })).toEqual({
      service: "Notion",
      present: "Checking Notion connection…",
      past: "Checked Notion connection",
      failure: "Couldn't check Notion connection",
    });
    expect(getCapabilityCallSentence(part)).toEqual({
      service: null,
      present: "Checking connection…",
      past: "Checked connection",
      failure: "Couldn't check connection",
    });
  });

  test("says which of your skills the answer is using", () => {
    const byName: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork-cloud_get_skill", toolCallId: "call_skill",
      state: "input-available", input: { name: "customer-briefing" },
    };
    expect(getCapabilityCallSentence(byName)).toMatchObject({ present: "Using your customer-briefing skill…", past: "Used your customer-briefing skill" });
    const byCapability: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork-cloud_get_skill", toolCallId: "call_skill",
      state: "output-available", input: { name: "plugin:plg_1:cob_1" }, output: { name: "customer-briefing", content: "" },
    };
    expect(getCapabilityCallSentence(byCapability).past).toBe("Used your customer-briefing skill");
    const skillMarkdown = { ...byCapability, output: "---\nname: customer-briefing-f5yqprwv\ndescription: \"A one-page brief\"\n---\n\nFind the meeting." };
    expect(getCapabilityCallSentence(skillMarkdown).past).toBe("Used your customer-briefing skill");
    expect(getCapabilityCallSentence({ ...byName, toolName: "openwork-cloud_list_skills", input: {} }).past).toBe("Looked through your skills");
  });

  test("does not classify other tools or non-exact wildcard names as probes", () => {
    for (const name of ["mcp:emc_probe:search", "mcp:emc_probe:*:extra", "mcp::*"]) {
      expect(getCapabilityCallSentence(executeCapability({ name })).failure).toBeUndefined();
    }
    expect(getCapabilityCallSentence({ ...executeCapability({ name: "mcp:emc_probe:*" }), toolName: "third-party_execute_capability" }).failure).toBeUndefined();
  });
  test("names an org MCP capability instead of falling back to 'a capability'", () => {
    const part = executeCapability({
      name: "mcp:emc_01kx2kfb42f6d94y1s1j992jhf:query_granola_meetings",
      body: '{"query": "action items from recent meetings"}',
    });

    const sentence = getCapabilityCallSentence(part);

    expect(sentence.past).toContain("Queried granola meetings");
    expect(sentence.present).toContain("Querying granola meetings");
    expect(sentence.past).not.toContain("a capability");
    // The opaque connection id never reaches the reader.
    expect(sentence.past).not.toContain("emc_01kx2kfb42f6d94y1s1j992jhf");
  });

  test("reads the ask out of a JSON-string body", () => {
    const part = executeCapability({
      name: "mcp:emc_01kx:query_granola_meetings",
      body: '{"query": "action items from recent meetings"}',
    });

    expect(getCapabilityCallQuote(part)).toBe("action items from recent meetings");
    expect(getCapabilityCallSentence(part).past).toContain("action items from recent meetings");
  });

  test("still reads the ask out of an object body", () => {
    const part = executeCapability({
      name: "mcp:emc_01kx:query_granola_meetings",
      body: { query: "yesterday's notes" },
    });

    expect(getCapabilityCallQuote(part)).toBe("yesterday's notes");
  });

  test("keeps naming dotted capabilities by service", () => {
    const part = executeCapability({ name: "granola.get_meetings" });
    const sentence = getCapabilityCallSentence(part);

    expect(sentence.service).toBe("Granola");
    expect(sentence.past).toContain("Fetched meetings");
  });

  test("falls back to a generic sentence only when the name is unusable", () => {
    expect(getCapabilityCallSentence(executeCapability({})).past).toBe("Ran a capability");
  });
});
