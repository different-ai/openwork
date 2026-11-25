import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

const bridge = vi.hoisted(() => ({ requests: [] as { path: string; body: unknown }[] }));
vi.mock("../src/opencode-plugins/openwork-ui-bridge.js", () => ({
  uiBridgeRequest: async (path: string, options: { body?: unknown }) => {
    bridge.requests.push({ path, body: options.body });
    return { ok: true };
  },
}));

import { singleActionAsList } from "../src/opencode-plugins/browser-tool-args.js";
import { server as browserTools } from "../src/opencode-plugins/openwork-chrome-devtools.js";
import { server as computerTools } from "../src/opencode-plugins/openwork-computer-use.js";
import nativeContext from "../src/opencode-plugins/openwork-context-v2.js";

const computer = (await computerTools()).tool.computer_act;
const browser = (await browserTools()).tool.browser_act;
const caller = { sessionID: "s" };

type ToolEvent = { tool: string; input: unknown };

async function engineHooks() {
  const hooks: ((event: ToolEvent) => void | Promise<void>)[] = [];
  const stop = await nativeContext.setup({
    options: { url: "http://127.0.0.1:9/read", token: "t", browser: { url: "http://127.0.0.1:9/browser", token: "t" } },
    tool: {
      async transform() { return { async dispose() {} }; },
      async hook(_name, callback) { hooks.push(callback); return { async dispose() {} }; },
    },
    skill: { async transform() { return { async dispose() {} }; }, async reload() {} },
  });
  const before = async (event: ToolEvent) => { for (const hook of hooks) await hook(event); return event.input; };
  return { before, stop };
}

beforeEach(() => { bridge.requests.length = 0; });

describe("the model is shown each tool's action list once", () => {
  test.each([["computer_act", computer], ["browser_act", browser]] as const)("%s offers actions and no separate action", (_name, tool) => {
    expect(Object.keys(tool.args)).toContain("actions");
    expect(Object.keys(tool.args)).not.toContain("action");
    const whole = JSON.stringify(z.toJSONSchema(z.object(tool.args)));
    const list = JSON.stringify(z.toJSONSchema(tool.args.actions.element));
    expect(whole.length).toBeLessThan(2 * list.length);
  });

  test("a call must carry at least one step", () => {
    expect(z.object(computer.args).safeParse({ observation_id: "o1" }).success).toBe(false);
    expect(z.object(computer.args).safeParse({ observation_id: "o1", actions: [] }).success).toBe(false);
    expect(z.object(browser.args).safeParse({ observationId: "o1" }).success).toBe(false);
  });
});

describe("a call that still passes one action keeps working", () => {
  test("computer_act runs a lone action as a one-step list", async () => {
    await computer.execute({ observation_id: "o1", intent: "Press Save", action: { type: "press", ref: "e1" } }, caller);
    expect(bridge.requests).toEqual([{ path: "/computer/task", body: {
      name: "computer_act", sessionId: "s",
      args: { observation_id: "o1", intent: "Press Save", actions: [{ type: "press", ref: "e1" }] },
    } }]);
  });

  test("computer_act passes a list through unchanged", async () => {
    const actions = [{ type: "press", ref: "e1" }, { type: "press", ref: "e2" }];
    await computer.execute({ observation_id: "o1", actions }, caller);
    expect(bridge.requests).toEqual([{ path: "/computer/task", body: { name: "computer_act", sessionId: "s", args: { observation_id: "o1", actions } } }]);
  });

  test("computer_act refuses a call that passes both forms", async () => {
    const result = await computer.execute({ observation_id: "o1", action: { type: "press", ref: "e1" }, actions: [{ type: "press", ref: "e2" }] }, caller);
    expect(JSON.parse(String(result))).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(bridge.requests).toEqual([]);
  });

  test("browser_act runs a lone action as a one-step list", async () => {
    await browser.execute({ observationId: "o1", action: { type: "click", ref: "e1" } }, caller);
    expect(bridge.requests).toEqual([{ path: "/browser/task", body: {
      operation: "act", sessionId: "s",
      args: { observationId: "o1", actions: [{ type: "click", ref: "e1" }] },
    } }]);
  });

  test("browser_act still accepts a lone action sent as a JSON string", async () => {
    await browser.execute({ observationId: "o1", action: JSON.stringify({ type: "click", ref: "e1" }) }, caller);
    expect(bridge.requests[0]?.body).toMatchObject({ args: { actions: [{ type: "click", ref: "e1" }] } });
  });
});

describe("the engine receives a lone action as a list before it checks the call", () => {
  test("a lone action becomes a one-step list, parsed when it arrives as a JSON string", () => {
    expect(singleActionAsList({ observation_id: "o1", action: { type: "press", ref: "e1" } }))
      .toEqual({ observation_id: "o1", actions: [{ type: "press", ref: "e1" }] });
    expect(singleActionAsList({ observationId: "o1", action: JSON.stringify({ type: "click", ref: "e1" }) }))
      .toEqual({ observationId: "o1", actions: [{ type: "click", ref: "e1" }] });
  });

  test("a list and anything that is not a call object are left as they are", () => {
    const listed = { observation_id: "o1", actions: [{ type: "press", ref: "e1" }] };
    expect(singleActionAsList(listed)).toBe(listed);
    expect(singleActionAsList("o1")).toBe("o1");
    expect(singleActionAsList(null)).toBe(null);
  });

  test("a call that passes both forms is refused instead of losing a step", () => {
    expect(() => singleActionAsList({ action: { type: "press", ref: "e1" }, actions: [{ type: "press", ref: "e2" }] }))
      .toThrow("not in both action and actions");
  });

  test("only computer_act and browser_act calls are rewritten", async () => {
    const engine = await engineHooks();
    try {
      expect(await engine.before({ tool: "computer_act", input: { observation_id: "o1", action: { type: "press", ref: "e1" } } }))
        .toEqual({ observation_id: "o1", actions: [{ type: "press", ref: "e1" }] });
      expect(await engine.before({ tool: "browser_act", input: { observationId: "o1", action: { type: "click", ref: "e1" } } }))
        .toEqual({ observationId: "o1", actions: [{ type: "click", ref: "e1" }] });
      const other = { action: "left alone" };
      expect(await engine.before({ tool: "computer_run", input: other })).toBe(other);
      await expect(engine.before({ tool: "computer_act", input: { action: { type: "press", ref: "e1" }, actions: [] } }))
        .rejects.toThrow("not in both action and actions");
    } finally { await engine.stop(); }
  });
});
