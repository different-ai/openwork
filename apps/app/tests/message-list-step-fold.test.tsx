/** @jsxImportSource react */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { createDefaultPlatform, PlatformProvider } from "../src/react-app/kernel/platform";
import type { ThreadStatus } from "../src/lib/messages";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Base UI chooses its layout-effect implementation at module initialization.
const { MessageList } = await import("../src/components/chat/message-list");
const { MessageListProvider } = await import("../src/components/chat/message-list-provider");
const mcpAppFrame = await import("../src/components/chat/mcp-app-frame");
const { useWorkbenchUiState, MAX_WORKBENCH_DISCLOSURES } = await import("../src/react-app/domains/session/chat/workbench-ui-state");
beforeEach(() => useWorkbenchUiState.setState({ disclosures: new Map() }));
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

function bashPart(id: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}`, description: "run" },
    output: "ok",
  };
}

function editPart(id: string, filePath: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "edit",
    toolCallId: id,
    state: "output-available",
    input: { filePath, oldString: "a", newString: "b" },
    output: "ok",
  };
}

/**
 * Other test files stub `globalThis.window` and can leak it into a shared
 * bun test worker. Static SSR rendering must not see a partial window stub
 * (components probe it for addEventListener), so hide it for the render.
 */
function withoutWindow<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (descriptor?.configurable) {
    Reflect.deleteProperty(globalThis, "window");
  }
  try {
    return run();
  } finally {
    if (descriptor?.configurable) {
      Object.defineProperty(globalThis, "window", descriptor);
    }
  }
}

type Owner = { workspaceId: string; sessionId: string; uiStateOwner: string };

function list(messages: UIMessage[], status: ThreadStatus = "ready", highlightQuery = "", owner?: Owner) {
  return (
    <PlatformProvider value={createDefaultPlatform()}>
    <MessageListProvider
      key={owner?.uiStateOwner}
      workspaceId={owner?.workspaceId ?? "ws"}
      sessionId={owner?.sessionId ?? "session"}
      uiStateOwner={owner?.uiStateOwner}
      showThinking={true}
      highlightQuery={highlightQuery}
      developerMode={false}
      displaySuggestions={false}
      providerConnectedCount={1}
      dispatchAction={() => {}}
      setPrompt={() => {}}
      onRevertToUserMessage={() => {}}
      onForkAtMessage={() => {}}
      onEditUserMessage={() => {}}
      onMcpReconnect={() => Promise.reject(new Error("unused"))}
      onMcpReopenAuthorization={() => Promise.resolve()}
      onMcpRetry={() => {}}
    >
      <MessageList messages={messages} status={status} activityStatus={status === "streaming" ? "thinking" : "idle"} />
    </MessageListProvider>
    </PlatformProvider>
  );
}

function renderList(messages: UIMessage[]) {
  return withoutWindow(() => renderToStaticMarkup(list(messages)));
}

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  metadata: { opencode: { created: 1_000 } },
  parts: [{ type: "text", text: "do the thing", state: "done" }],
};

describe("finished turn step fold (single OpenCode message per turn)", () => {
  test("folds interleaved steps into a 'Worked for …' line and keeps the answer", () => {
    const assistant: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 80_000 } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "planning the change", state: "done" },
        bashPart("c1"),
        editPart("c2", "/repo/src/a.ts"),
        bashPart("prefix-3"),
        bashPart("prefix-4"),
        { type: "text", text: "Now checking the result:", state: "done" },
        bashPart("c3"),
        bashPart("c4"),
        bashPart("c5"),
        { type: "text", text: "Everything passed — the change is in.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // 79 seconds of work between created and completed.
    expect(markup).toContain("Worked for 1m 19s");
    // The answer stays visible outside the fold.
    expect(markup).toContain("Everything passed — the change is in.");
  });

  test("a short turn stays inline with one aggregate line", () => {
    const assistant: UIMessage = {
      id: "assistant-2",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 5_000 } },
      parts: [
        { type: "step-start" },
        bashPart("c1"),
        editPart("c2", "/repo/src/a.ts"),
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    expect(markup).not.toContain("Worked for");
    // Both calls merge into one aggregate summary line.
    expect(markup).toContain("Edited 1 file, ran command");
    expect(markup).toContain("Done.");
  });

  test("reasoning between calls stays one aggregate line that advertises its thought", () => {
    const assistant: UIMessage = {
      id: "assistant-3",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 4_000 } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "first", state: "done" },
        bashPart("c1"),
        { type: "reasoning", text: "second", state: "done" },
        bashPart("c2"),
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // No thought/command ladder: the run is ONE aggregate line…
    expect(markup).toContain("Ran 2 commands");
    // …that counts the thought it carries.
    expect(markup).toContain("1 thought");

    // The turn-opening thought still renders as its own line above the run.
    const openingThought = markup.indexOf("Thought");
    const run = markup.indexOf("Ran 2 commands");
    expect(openingThought).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(openingThought);
  });
});

async function mounted(run: (container: HTMLDivElement, render: (messages: UIMessage[], status?: ThreadStatus, query?: string, owner?: Owner) => Promise<void>) => Promise<void>) {
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await run(container, async (messages, status = "streaming", query = "", owner) => {
      await act(async () => root.render(list([userMessage, ...messages], status, query, owner)));
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  }
}

function longRun(id: string, count = 6): UIMessage {
  return {
    id, role: "assistant",
    metadata: { opencode: { created: 1_000, completed: 80_000 } },
    parts: Array.from({ length: count }, (_, index) => bashPart(`${id}-${index}`)),
  };
}

function stepToggle(container: HTMLElement) {
  const toggle = container.querySelector<HTMLButtonElement>('[data-step-run] > div > button');
  if (!toggle) throw new Error("Missing step disclosure");
  return toggle;
}

describe("long-task reading continuity", () => {
  test.each([false, true])("restores explicit shell choice %s after A-B-A, isolates owners, and survives mounted cache eviction", async (open) => {
    await mounted(async (container, render) => {
      const a = { workspaceId: "ws-a", sessionId: "shared", uiStateOwner: "server-a/ws-a/shared" };
      const b = { workspaceId: "ws-b", sessionId: "shared", uiStateOwner: "server-b/ws-b/shared" };
      const c = { workspaceId: "ws-a", sessionId: "other", uiStateOwner: "server-a/ws-a/other" };
      const run = longRun("same-message-id");
      const status = open ? "ready" : "streaming";
      await render([run], status, "", a);
      const firstShell = container.querySelector("[data-step-run]");
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe(String(!open));
      await act(async () => stepToggle(container).click());
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe(String(open));
      for (const other of [b, c]) {
        await render([run], status, "", other);
        expect(firstShell?.isConnected).toBe(false);
        expect(stepToggle(container).getAttribute("aria-expanded")).toBe(String(!open));
        await render([run], status, "", a);
        expect(container.querySelector("[data-step-run]")).not.toBe(firstShell);
        expect(stepToggle(container).getAttribute("aria-expanded")).toBe(String(open));
      }
      await render([longRun("same-message-id", 12)], "ready", "", a);
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe(String(open));
      const currentShell = container.querySelector("[data-step-run]");
      await act(async () => {
        for (let index = 0; index <= MAX_WORKBENCH_DISCLOSURES; index++) {
          useWorkbenchUiState.getState().setDisclosure(`eviction-${index}`, false);
        }
      });
      expect(useWorkbenchUiState.getState().disclosures.size).toBe(MAX_WORKBENCH_DISCLOSURES);
      expect(container.querySelector("[data-step-run]")).toBe(currentShell);
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe(String(open));
    });
  });

  test("keeps actual expanded tool/detail nodes and focus through the first answer, more events, and completion", async () => {
    await mounted(async (container, render) => {
      const completed = longRun("continuity");
      const initial: UIMessage = {
        ...completed,
        metadata: { opencode: { created: 1_000 } },
        parts: [...completed.parts.slice(0, -1), { ...bashPart("continuity-5"), state: "input-available" }],
      };
      await render([initial]);
      const shell = container.querySelector("[data-step-run]");
      const aggregate = container.querySelector("[data-tool-aggregate]");
      const expand = aggregate?.querySelector<HTMLButtonElement>("button");
      if (!expand) throw new Error("Missing aggregate");
      await act(async () => expand.click());
      const detail = [...aggregate?.querySelectorAll<HTMLButtonElement>('[data-tool-aggregate-detail="command"]') ?? []].at(-1);
      if (!detail) throw new Error("Missing command detail");
      await act(async () => detail.click());
      detail.focus();
      const text: UIMessage["parts"][number] = { type: "text", text: "First narrative needle", state: "done" };
      const answer: UIMessage = { ...completed, parts: [...completed.parts, text] };
      await render([answer]);
      const proseRoot = container.querySelector('[data-message-id="continuity"]');
      expect(proseRoot).not.toBeNull();
      const later: UIMessage = { ...answer, parts: [...answer.parts, bashPart("later-tool"), { type: "text", text: "Final answer", state: "done" }] };
      await render([later]);
      expect(container.querySelector('[data-message-id="continuity"]')).toBe(proseRoot);
      await render([later], "ready");
      expect(container.querySelector("[data-step-run]")).toBe(shell);
      expect(container.querySelector("[data-tool-aggregate]")).toBe(aggregate);
      expect([...aggregate?.querySelectorAll('[data-tool-aggregate-detail="command"]') ?? []].at(-1)).toBe(detail);
      expect(detail.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(detail);
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe("true");
      expect(proseRoot?.isConnected).toBe(true);
      expect(proseRoot?.closest("[data-step-run]")).toBeNull();
      expect(container.textContent).toContain("Final answer");
    });
  });

  test("keeps opened reasoning in its original section instead of relocating it on completion", async () => {
    await mounted(async (container, render) => {
      const initial = longRun("reasoning-continuity");
      const message: UIMessage = { ...initial, parts: [
        { type: "reasoning", text: "Planning detail", state: "done" },
        ...initial.parts,
        { type: "text", text: "Narrative", state: "done" },
        { type: "reasoning", text: "Checking detail", state: "streaming" },
      ] };
      await render([{ ...message, parts: message.parts.slice(0, -2) }]);
      const leading = container.querySelector("[data-reasoning-block]");
      const leadingToggle = leading?.querySelector<HTMLButtonElement>("button");
      if (!leadingToggle) throw new Error("Missing leading thought");
      await act(async () => leadingToggle.click());
      await render([message]);
      const blocks = [...container.querySelectorAll("[data-reasoning-block]")];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toBe(leading);
      for (const block of blocks) {
        const button = block.querySelector<HTMLButtonElement>("button");
        if (!button) throw new Error("Missing reasoning disclosure");
        if (button.getAttribute("aria-expanded") !== "true") await act(async () => button.click());
      }
      const settled: UIMessage = { ...message, parts: message.parts.map((part) => part.type === "reasoning" ? { ...part, state: "done" } : part) };
      await render([settled], "ready");
      expect([...container.querySelectorAll("[data-reasoning-block]")]).toEqual(blocks);
      for (const block of blocks) expect(block.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
      expect(blocks[0].closest("[data-step-run]")).not.toBeNull();
      expect(blocks[1].closest("[data-step-run]")).toBeNull();
    });
  });

  test("honors a manual fold across hundreds of steps and completion; Find reveals without erasing the choice", async () => {
    await mounted(async (container, render) => {
      const initial = longRun("fold-choice");
      await render([initial]);
      const toggle = stepToggle(container);
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      const large = longRun("fold-choice", 200);
      await render([large]);
      expect(stepToggle(container)).toBe(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.textContent).toContain("Live activity");
      expect(toggle.textContent).toContain("200 steps");
      expect(toggle.querySelector(".ow-text-shimmer, .animate-pulse, .animate-spin")).toBeNull();
      await render([large], "ready");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      const panel = container.querySelector('[data-step-run] > [data-slot="collapsible-content"]');
      expect(panel?.getAttribute("hidden")).toBe("until-found");
      await render([large], "ready", "fold-choice");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      await render([large], "ready");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await act(async () => panel?.dispatchEvent(new Event("beforematch")));
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const aggregateToggle = panel?.querySelector<HTMLButtonElement>("[data-tool-aggregate] > button");
      if (!aggregateToggle) throw new Error("Missing full history disclosure");
      await act(async () => aggregateToggle.click());
      const showAll = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Show 192 more"));
      if (!showAll) throw new Error("Missing bounded aggregate history control");
      await act(async () => showAll.click());
      expect(container.textContent).toContain("fold-choice-199");
    });
  });

  test("never folds a short live run automatically when it crosses the historical fold threshold", async () => {
    await mounted(async (container, render) => {
      await render([longRun("threshold", 2)]);
      const shell = container.querySelector("[data-step-run]");
      await render([longRun("threshold", 8)]);
      await render([longRun("threshold", 8)], "ready");
      expect(container.querySelector("[data-step-run]")).toBe(shell);
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe("true");
    });
  });

  test.each(["input-available", "approval-requested", "output-error"] as const)("reveals %s and keeps the revealed detail open after settlement", async (state) => {
    await mounted(async (container, render) => {
      const initial = longRun(`critical-${state}`);
      await render([initial]);
      await act(async () => stepToggle(container).click());
      const part: DynamicToolUIPart = state === "output-error"
        ? { ...bashPart("critical"), state, errorText: "Could not complete the command" }
        : state === "approval-requested"
          ? { ...bashPart("critical"), state, approval: { id: "approval-1" } }
          : { ...bashPart("critical"), state };
      const next: UIMessage = { ...initial, parts: [...initial.parts, part] };
      await render([next]);
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe("true");
      expect(stepToggle(container).getAttribute("aria-disabled")).toBe("true");
      await act(async () => stepToggle(container).click());
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe("true");
      await render([{ ...initial, parts: [...initial.parts, bashPart("critical")] }], "ready");
      expect(stepToggle(container).getAttribute("aria-expanded")).toBe("true");
      expect(stepToggle(container).getAttribute("aria-disabled")).not.toBe("true");
    });
  });

  test("keeps interactive connection results outside the fold across completion", async () => {
    await mounted(async (container, render) => {
      const app: DynamicToolUIPart = {
        type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "connection-app",
        state: "output-available", input: { name: "mcp:fixture:*" },
        output: { schemaVersion: "1", connectionId: "fixture", connectionName: "Notes", state: "needs_connection",
          actor: "member", message: "Connect Notes to continue.",
          action: { type: "connect", label: "Connect Notes", surface: "openwork_your_connections" } },
      };
      const initial = longRun("interactive");
      const next = { ...initial, parts: [...initial.parts, app] };
      await render([next]);
      const button = container.querySelector('button[aria-label="Connect Notes"]');
      if (!button) throw new Error("Missing interactive app control");
      expect(button.closest("[data-step-run]")).toBeNull();
      await render([next], "ready");
      expect(button.isConnected).toBe(true);
      expect(stepToggle(container).getAttribute("aria-disabled")).toBe("true");
    });
  });

  test("does not remount or hide an interactive iframe when its surrounding run settles", async () => {
    let mounts = 0;
    let unmounts = 0;
    // Isolate the transport leaf: no resource resolution, sandbox or network.
    // The real MessageList/MessageGroup still own this component's lifecycle.
    function InteractiveFixture() {
      useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
      return <iframe title="Fixture interactive view" />;
    }
    const frame = spyOn(mcpAppFrame, "McpAppFrame").mockImplementation(InteractiveFixture);
    try {
      await mounted(async (container, render) => {
        const initial = longRun("frame-continuity");
        const app: DynamicToolUIPart = {
          type: "dynamic-tool", toolName: "fixture_render", toolCallId: "fixture-app",
          state: "output-available", input: {}, output: {},
          callProviderMetadata: { openwork: { mcpResult: { content: [], _meta: { "openwork/mcpApp": {
            toolName: "fixture_render", resourceUri: "ui://fixture/view.html", arguments: {},
          } } } } },
        };
        await render([{ ...initial, parts: [...initial.parts, app] }]);
        const iframe = container.querySelector("iframe");
        expect(iframe).not.toBeNull();
        const next = { ...initial, parts: [...initial.parts, app, bashPart("after-app")] };
        await render([next]);
        await render([next], "ready");
        expect(container.querySelector("iframe")).toBe(iframe);
        expect(iframe?.closest("[data-step-run], [hidden]")).toBeNull();
        expect(mounts).toBe(1);
        expect(unmounts).toBe(0);
      });
      expect(unmounts).toBe(1);
    } finally {
      frame.mockRestore();
    }
  });
});
