import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { runToolTurn } from "@openwork/behaviors";
import { browserFastPath } from "../worlds/browser-fast-path.ts";

const test = spec.world(browserFastPath, {
  timeout: 420_000,
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "Website tools run in Electron's native page view, reached through the engine's browser tools.",
  },
});

const page = { tabId: "__TAB__" };
const parse = (output: string): Record<string, unknown> => { try { return JSON.parse(output); } catch { return {}; } };

test("an agent saves through a website's own tool and confirms it on the page", async ({ world, user, probe, step, evidence }) => {
  const witness = () => probe.browserFixtureState(world.origin);

  await step("before: the website has recorded no saves", async () => {
    await user.click({ text: world.session.title });
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    expect((await witness()).records).toEqual([]);
    await user.screenshot();
  });

  await step("after: the agent lists the website's tools, saves through one and sees it on the page", async () => {
    // The witness model only calls tools the engine offered it.
    await runToolTurn({ user }, world, "Save the draft with the website's own tool.", [
      { tool: "browser_open", arguments: { url: `${world.origin}/` } },
      { tool: "webmcp_list_tools", argumentsFrom: "browser-page", arguments: page },
      { tool: "webmcp_call_tool", argumentsFrom: "browser-page", arguments: { ...page, toolName: "save_draft", input: { confirm: true } } },
      { tool: "browser_observe", argumentsFrom: "browser-page", arguments: { ...page, includeText: true } },
    ]);
    const saved = await probe.eventually(witness, { within: 15_000, label: "the site records the website tool", until: state => state.records.length === 1 });
    expect(saved.records).toEqual([{ method: "webmcp", count: 1, signedIn: false }]);
    const calls = await world.browserCalls();
    expect(calls.map(call => call.tool)).toEqual(["browser_open", "webmcp_list_tools", "webmcp_call_tool", "browser_observe"]);
    const [, listed, called, observed] = calls.map(call => parse(call.output));
    const tools = listed?.tools as Array<{ name: string }> | undefined;
    expect(tools?.map(tool => tool.name)).toContain("save_draft");
    expect(called).toMatchObject({ ok: true, dispatched: true, name: "save_draft", result: { saved: 1, signedIn: false } });
    expect(observed).toMatchObject({ ok: true, siteTools: tools?.length });
    expect(observed?.text).toContain("Saved 1");
    evidence.recordAssertionEvidence("The tool's result and the page agree", `Recorded saves: ${saved.records.length}; website tools offered: ${tools?.length}`,
      saved.records.length === 1 && String(observed?.text).includes("Saved 1"));
    await user.screenshot();
  });
});
