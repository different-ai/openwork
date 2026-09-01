import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart, UIMessage } from "ai";

import {
  deriveThreadActivity,
  EMPTY_THREAD_ACTIVITY,
} from "../src/react-app/domains/session/panel/thread-activity";

let nextCallId = 0;

function toolPart(
  toolName: string,
  input: Record<string, unknown>,
  options: {
    state?: DynamicToolUIPart["state"];
    openwork?: Record<string, unknown>;
  } = {},
): DynamicToolUIPart {
  nextCallId += 1;
  const state = options.state ?? "output-available";
  const base = {
    type: "dynamic-tool" as const,
    toolName,
    toolCallId: `call-${nextCallId}`,
    input,
    ...(options.openwork
      ? { callProviderMetadata: { openwork: options.openwork } }
      : {}),
  };
  if (state === "output-error") {
    return { ...base, state, input, errorText: "failed" };
  }
  if (state === "output-available") {
    return { ...base, state, input, output: "ok" };
  }
  return { ...base, state, input };
}

function message(parts: UIMessage["parts"]): UIMessage {
  return { id: `msg-${nextCallId}`, role: "assistant", parts };
}

describe("deriveThreadActivity", () => {
  test("returns empty activity for an empty transcript", () => {
    expect(deriveThreadActivity([])).toEqual(EMPTY_THREAD_ACTIVITY);
  });

  test("aggregates changed files across tools and sums repeat edits", () => {
    const activity = deriveThreadActivity([
      message([
        toolPart("edit", { filePath: "src/a.ts" }, {
          openwork: { changedFiles: [{ file: "src/a.ts", kind: "modified", additions: 3, deletions: 1 }] },
        }),
        toolPart("write", { filePath: "notes/plan.md" }, {
          openwork: { changedFiles: [{ file: "notes/plan.md", kind: "added", additions: 5, deletions: 0 }] },
        }),
      ]),
      message([
        toolPart("edit", { filePath: "src/a.ts" }, {
          openwork: { changedFiles: [{ file: "src/a.ts", kind: "modified", additions: 2, deletions: 2 }] },
        }),
      ]),
    ]);

    expect(activity.changes.files).toEqual([
      { file: "src/a.ts", kind: "modified", additions: 5, deletions: 3 },
      { file: "notes/plan.md", kind: "added", additions: 5, deletions: 0 },
    ]);
    expect(activity.changes.additions).toBe(10);
    expect(activity.changes.deletions).toBe(3);
  });

  test("collects sub-agent runs with status and child session id", () => {
    const activity = deriveThreadActivity([
      message([
        toolPart("task", { description: "Explore the repo", subagent_type: "explore" }, {
          state: "input-available",
          openwork: { childSessionId: "ses_child_1" },
        }),
        toolPart("task", { description: "Fix the bug", subagent_type: "general" }),
        toolPart("task", { description: "Broken run", subagent_type: "general" }, { state: "output-error" }),
      ]),
    ]);

    expect(activity.subagents).toEqual([
      {
        toolCallId: activity.subagents[0]?.toolCallId ?? "",
        title: "Explore the repo",
        agentType: "explore",
        childSessionId: "ses_child_1",
        status: "running",
      },
      {
        toolCallId: activity.subagents[1]?.toolCallId ?? "",
        title: "Fix the bug",
        agentType: "general",
        childSessionId: null,
        status: "completed",
      },
      {
        toolCallId: activity.subagents[2]?.toolCallId ?? "",
        title: "Broken run",
        agentType: "general",
        childSessionId: null,
        status: "failed",
      },
    ]);
  });

  test("collects terminal commands with exit codes and skips empty input", () => {
    const activity = deriveThreadActivity([
      message([
        toolPart("bash", { command: "pnpm test", description: "Run tests" }, {
          openwork: { exitCode: 0 },
        }),
        toolPart("bash", { command: "pnpm build" }, {
          state: "output-error",
          openwork: { exitCode: 1 },
        }),
        toolPart("bash", { command: "sleep 5" }, { state: "input-available" }),
        toolPart("bash", {}),
      ]),
    ]);

    expect(activity.commands).toEqual([
      {
        toolCallId: activity.commands[0]?.toolCallId ?? "",
        command: "pnpm test",
        description: "Run tests",
        status: "completed",
        exitCode: 0,
      },
      {
        toolCallId: activity.commands[1]?.toolCallId ?? "",
        command: "pnpm build",
        description: null,
        status: "failed",
        exitCode: 1,
      },
      {
        toolCallId: activity.commands[2]?.toolCallId ?? "",
        command: "sleep 5",
        description: null,
        status: "running",
        exitCode: null,
      },
    ]);
  });

  test("ignores malformed forwarded metadata", () => {
    const activity = deriveThreadActivity([
      message([
        toolPart("edit", { filePath: "src/a.ts" }, {
          openwork: {
            changedFiles: [
              { file: "", kind: "modified" },
              { file: "src/ok.ts", kind: "unknown" },
              { file: "src/kept.ts", kind: "modified", additions: "3", deletions: null },
              "not-an-object",
            ],
          },
        }),
      ]),
    ]);

    expect(activity.changes.files).toEqual([
      { file: "src/kept.ts", kind: "modified", additions: 0, deletions: 0 },
    ]);
  });
});
