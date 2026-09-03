/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";

import { DetailBox, ToolAggregateGroup, buildAggregateRows } from "../src/components/chat/tool-aggregate-group";
import { getAggregateNowPart, getAggregateRowSearch } from "../src/lib/tool-aggregate";
import { CurrentToolLifecycleProvider } from "../src/components/chat/current-tool-lifecycle-context";
import { getToolAggregateLifecycle } from "../src/lib/tool-aggregate";

const runningCommand: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "bash",
  toolCallId: "running-command",
  state: "input-available",
  input: { command: "git status", description: "Check repository state" },
};

const completedCommand: DynamicToolUIPart = {
  ...runningCommand,
  toolCallId: "completed-command",
  state: "output-available",
  output: "clean",
};

const failedCommand: DynamicToolUIPart = {
  ...runningCommand,
  toolCallId: "failed-command",
  state: "output-error",
  errorText: "Process exited with code 2",
};

describe("tool aggregate running feedback", () => {
  test("classifies only lifecycle facts the aggregate can prove", () => {
    expect(getToolAggregateLifecycle([runningCommand], "running")).toBe("running");
    expect(getToolAggregateLifecycle([runningCommand], "waiting")).toBe("waiting");
    expect(getToolAggregateLifecycle([runningCommand], "interrupted")).toBe("unknown");
    expect(getToolAggregateLifecycle([completedCommand], null)).toBe("completed");
    expect(getToolAggregateLifecycle([failedCommand], null)).toBe("failed");
  });

  test("uses a quiet shimmer instead of a spinner for the current action", () => {
    const markup = renderToStaticMarkup(
      <CurrentToolLifecycleProvider
        activityStatus="responding"
        currentToolCallIds={new Set([runningCommand.toolCallId])}
      >
        <ToolAggregateGroup parts={[runningCommand]} />
      </CurrentToolLifecycleProvider>,
    );

    expect(markup).toContain("Running command");
    expect(markup).not.toContain("Running 1 command");
    expect(markup).not.toContain("Now:");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).not.toContain("animate-spin");
  });

  test("the running command line invites a double-click to show the whole command", () => {
    const markup = renderToStaticMarkup(
      <CurrentToolLifecycleProvider
        activityStatus="responding"
        currentToolCallIds={new Set([runningCommand.toolCallId])}
      >
        <ToolAggregateGroup parts={[completedCommand, runningCommand]} />
      </CurrentToolLifecycleProvider>,
    );

    expect(getAggregateNowPart([completedCommand, runningCommand])).toBe(runningCommand);
    expect(markup).toContain("data-tool-aggregate-now");
    expect(markup).toContain('title="Double-click to show the full command"');
    // Until double-clicked, the line stays the one-line shimmer, not the box.
    expect(markup).not.toContain("data-tool-aggregate-copy");
  });

  test("a running file action's current line offers no command reveal", () => {
    const runningRead: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "running-read",
      state: "input-available",
      input: { filePath: "/repo/brief.md" },
    };

    const markup = renderToStaticMarkup(
      <CurrentToolLifecycleProvider
        activityStatus="responding"
        currentToolCallIds={new Set([runningCommand.toolCallId, runningRead.toolCallId])}
      >
        <ToolAggregateGroup parts={[runningCommand, runningRead]} />
      </CurrentToolLifecycleProvider>,
    );

    expect(getAggregateNowPart([runningCommand, runningRead])).toBe(runningRead);
    expect(markup).toContain("Reading brief.md");
    expect(markup).not.toContain("Double-click to show the full command");
  });

  test("shimmers the whole active action without a Now prefix", () => {
    const settledRead: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "settled-read",
      state: "output-available",
      input: { filePath: "/repo/other.tsx" },
      output: "contents",
    };
    const runningEdit: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "edit",
      toolCallId: "running-edit",
      state: "input-available",
      input: { filePath: "/repo/message-list.tsx" },
    };

    const markup = renderToStaticMarkup(
      <CurrentToolLifecycleProvider
        activityStatus="responding"
        currentToolCallIds={new Set([runningEdit.toolCallId])}
      >
        <ToolAggregateGroup parts={[settledRead, runningEdit]} />
      </CurrentToolLifecycleProvider>,
    );

    expect(markup).not.toContain("Now:");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).toContain("Editing message-list.tsx");
  });

  test("a single file action renders as its row, not under a count header", () => {
    const settledEdit: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "edit",
      toolCallId: "settled-edit",
      state: "output-available",
      input: { filePath: "/repo/file-chip.tsx" },
      output: "ok",
    };

    const markup = renderToStaticMarkup(<ToolAggregateGroup parts={[settledEdit]} />);

    expect(markup).not.toContain("Edited 1 file");
    expect(markup).not.toContain("aria-expanded");
    expect(markup).toContain("Edited");
    expect(markup).toContain("file-chip.tsx");
  });

  test("a single running file action shimmers its verb in the solo row", () => {
    const runningEdit: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "edit",
      toolCallId: "running-edit",
      state: "input-available",
      input: { filePath: "/repo/message-list.tsx" },
    };

    const markup = renderToStaticMarkup(<ToolAggregateGroup parts={[runningEdit]} />);

    expect(markup).not.toContain("Editing 1 file");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).toContain("Editing");
    expect(markup).toContain("message-list.tsx");
  });
});

describe("tool aggregate row merging", () => {
  const readOf = (toolCallId: string, filePath: string): DynamicToolUIPart => ({
    type: "dynamic-tool",
    toolName: "read",
    toolCallId,
    state: "output-available",
    input: { filePath },
    output: "contents",
  });

  test("collapses repeated settled reads of the same file into one ×N row", () => {
    const rows = buildAggregateRows(
      [readOf("read-1", "/repo/message-list.tsx"), readOf("read-2", "/repo/message-list.tsx")],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.repeat).toBe(2);
    expect(rows[0]?.index).toBe(0);
    expect(rows[0]?.lastIndex).toBe(1);
  });

  test("keeps reads of different files as separate rows", () => {
    const rows = buildAggregateRows(
      [readOf("read-1", "/repo/a.tsx"), readOf("read-2", "/repo/b.tsx")],
      [],
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.repeat === 1)).toBe(true);
  });

  test("a thought anchored between two identical reads keeps them apart", () => {
    const rows = buildAggregateRows(
      [readOf("read-1", "/repo/a.tsx"), readOf("read-2", "/repo/a.tsx")],
      [{ afterIndex: 1, text: "Checking the export shape.", isStreaming: false }],
    );

    expect(rows).toHaveLength(2);
  });
});

describe("tool aggregate long details", () => {
  const longPattern = "seed_unfinished_tools|git status --short --branch|createSessionLifecycleEvalMessages";
  const multiLineError = "Process exited with code 2\nerror: pathspec 'release/2026.09' did not match any file(s) known to git\nhint: use 'git fetch origin release/2026.09' first";

  test("search rows keep the exact pattern and name their scope", () => {
    const grep: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "grep",
      toolCallId: "grep-1",
      state: "output-available",
      input: { pattern: longPattern, path: "apps/app/src", include: "*.tsx" },
      output: "2 matches",
    };
    const glob: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "glob",
      toolCallId: "glob-1",
      state: "input-available",
      input: { pattern: "**/*.e2e.test.ts" },
    };

    expect(getAggregateRowSearch(grep)).toEqual({
      verb: "Searched code",
      pattern: longPattern,
      scope: "apps/app/src · *.tsx",
    });
    expect(getAggregateRowSearch(glob)).toEqual({
      verb: "Searching files",
      pattern: "**/*.e2e.test.ts",
      scope: null,
    });
    expect(getAggregateRowSearch(runningCommand)).toBeNull();
  });

  test("an expanded command is a bounded scroll box with a copy action; collapsed it is one line", () => {
    const expanded = renderToStaticMarkup(
      <DetailBox kind="command" text="git status --short --branch" expanded onToggle={() => {}} />,
    );
    expect(expanded).toContain('data-command-expanded="true"');
    expect(expanded).toContain("max-h-60 overflow-y-auto whitespace-pre-wrap");
    expect(expanded).toContain("data-tool-aggregate-copy");
    expect(expanded).toContain('aria-label="Copy command"');

    const collapsed = renderToStaticMarkup(
      <DetailBox kind="command" text="git status --short --branch" expanded={false} onToggle={() => {}} />,
    );
    expect(collapsed).toContain('data-command-expanded="false"');
    expect(collapsed).toContain("line-clamp-1");
    expect(collapsed).not.toContain("overflow-y-auto");
    expect(collapsed).not.toContain("data-tool-aggregate-copy");
  });

  test("clicking a clipped command reveals every line and copies the full command", async () => {
    const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
    if (registeredDom) GlobalRegistrator.register();
    const previousRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    });
    // Shiki's inline highlighting lands asynchronously and replaces "\n" with
    // <br>, so read the command the way a person sees it, whether or not the
    // upgrade has happened yet, to stay independent of timing.
    const readCommandText = (node: Node): string => {
      if (node.nodeName === "BR") return "\n";
      if (node.childNodes.length === 0) return node.textContent ?? "";
      return Array.from(node.childNodes, readCommandText).join("");
    };
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        const visibleLines = this.classList.contains("line-clamp-1")
          ? 1
          : Math.max(1, readCommandText(this).split("\n").length);
        return new DOMRect(0, 0, 320, visibleLines * 20);
      },
    });
    const command = [
      "pnpm world up dev-headless --detach -- --replace",
      "pnpm --filter @openwork/app test",
      "pnpm --filter @openwork/app typecheck",
      "pnpm world down dev-headless",
    ].join("\n");
    const clipboardWrites: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clipboardWrites.push(text);
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let expanded = false;
    const render = () => root.render(
      <DetailBox
        kind="command"
        text={command}
        expanded={expanded}
        onToggle={() => {
          expanded = !expanded;
          render();
        }}
      />,
    );

    try {
      await act(async () => render());
      const collapsed = container.querySelector<HTMLElement>("[data-tool-aggregate-detail=command] code");
      if (!collapsed) throw new Error("Expected the collapsed command text");
      expect(Math.round(collapsed.getBoundingClientRect().height / 20)).toBe(1);
      expect(readCommandText(collapsed)).toBe(command);

      const toggle = container.querySelector<HTMLButtonElement>("[data-tool-aggregate-detail=command]");
      if (!toggle) throw new Error("Expected the command detail toggle");
      await act(async () => toggle.click());

      const revealed = container.querySelector<HTMLElement>("[data-tool-aggregate-detail=command] code");
      if (!revealed) throw new Error("Expected the revealed command text");
      expect(Math.round(revealed.getBoundingClientRect().height / 20)).toBe(command.split("\n").length);
      expect(readCommandText(revealed)).toBe(command);

      const copy = container.querySelector<HTMLButtonElement>("[data-tool-aggregate-copy]");
      if (!copy) throw new Error("Expected the expanded command copy action");
      await act(async () => copy.click());
      expect(clipboardWrites).toEqual([command]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (previousRect) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", previousRect);
      else Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
      if (registeredDom) await GlobalRegistrator.unregister();
    }
  });

  test("only commands offer a copy action; errors and patterns do not", () => {
    const error = renderToStaticMarkup(
      <DetailBox kind="error" text={multiLineError} expanded onToggle={() => {}} />,
    );
    const pattern = renderToStaticMarkup(
      <DetailBox kind="pattern" text={longPattern} expanded onToggle={() => {}} />,
    );
    expect(error).toContain("max-h-60 overflow-y-auto");
    expect(error).not.toContain("data-tool-aggregate-copy");
    expect(pattern).not.toContain("data-tool-aggregate-copy");
  });

  test("a failed solo file action exposes its whole error, not a clipped first line", () => {
    const failedRead: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "failed-read",
      state: "output-error",
      input: { filePath: "/repo/missing.md" },
      errorText: multiLineError,
    };

    const markup = renderToStaticMarkup(<ToolAggregateGroup parts={[failedRead]} />);

    expect(markup).toContain('data-tool-aggregate-detail="error"');
    expect(markup).toContain("aria-label=\"Show full error\"");
    expect(markup).toContain("hint: use &#x27;git fetch origin release/2026.09&#x27; first");
    expect(markup).not.toContain("failed —");
  });
});
