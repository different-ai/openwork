import { expect, test } from "bun:test"
import type { DynamicToolUIPart } from "ai"

import {
  commandProgram,
  parseGitHubReference,
  reasoningDurationMs,
  sentenceCase,
  splitSentence,
  textDiffStats,
  textGroupDiffStats,
  textGroupSummary,
  textStepSentence,
  textThoughtLabel,
} from "../src/lib/text-activity"

function done(toolName: string, input: Record<string, unknown>, callProviderMetadata?: DynamicToolUIPart["callProviderMetadata"]): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName, toolCallId: `${toolName}-${JSON.stringify(input)}`, state: "output-available", input, output: "", callProviderMetadata }
}

function failed(toolName: string, input: Record<string, unknown>): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName, toolCallId: `${toolName}-failed`, state: "output-error", input, errorText: "exit 1" }
}

function running(toolName: string, input: Record<string, unknown>): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName, toolCallId: `${toolName}-running`, state: "input-available", input }
}

const joined = (sentence: { verb: string; object: string }) => `${sentence.verb} ${sentence.object}`.trim()

test("a command names its description in sentence case, never the command line", () => {
  const part = done("bash", { command: "gh auth login --web", description: "gh auth login web flow" })
  expect(joined(textStepSentence(part, "done"))).toBe("Ran Gh auth login web flow")
  expect(joined(textStepSentence(running("bash", { command: "ls", description: "list Daytona sandboxes" }), "running"))).toBe("Running List Daytona sandboxes")
  expect(joined(textStepSentence(failed("bash", { command: "infisical export", description: "Export secrets from Infisical" }), "failed"))).toBe("Couldn't run Export secrets from Infisical")
  expect(joined(textStepSentence(done("bash", { command: "ls" }), "done"))).toBe("Ran a command")
})

test("files are named by their file name; the full path stays in the title", () => {
  const read = textStepSentence(done("read", { filePath: "/work/docs/manifest.md" }), "done")
  expect(joined(read)).toBe("Read manifest.md")
  expect(read.title).toBe("/work/docs/manifest.md")
  expect(joined(textStepSentence(done("write", { filePath: "/work/manifest.md", content: "a" }), "done"))).toBe("Wrote manifest.md")
  expect(joined(textStepSentence(done("edit", { filePath: "/work/composer.tsx", oldString: "a", newString: "b" }), "done"))).toBe("Edited composer.tsx")
  expect(joined(textStepSentence(failed("edit", { filePath: "/work/composer.tsx" }), "failed"))).toBe("Couldn't edit composer.tsx")
})

test("searches quote what was searched", () => {
  expect(joined(textStepSentence(done("grep", { pattern: "remoteThreadView" }), "done"))).toBe("Searched for “remoteThreadView”")
  expect(joined(textStepSentence(done("glob", { pattern: "**/*.md" }), "done"))).toBe("Searched files **/*.md")
})

test("a run of steps reads as one summary with exploring first", () => {
  const parts = [
    done("read", { filePath: "/a.md" }),
    done("read", { filePath: "/b.md" }),
    done("read", { filePath: "/a.md" }),
    done("grep", { pattern: "x" }),
    done("bash", { command: "ls", description: "List" }),
    done("bash", { command: "pwd", description: "Where" }),
    done("bash", { command: "ls", description: "List" }),
    done("bash", { command: "git status", description: "Status" }),
  ]
  const summary = textGroupSummary(parts, "past")
  expect(summary.map(joined).join(", ")).toBe("Explored 2 files, 1 search, ran 4 commands")
  expect(summary.map((segment) => segment.verb)).toEqual(["Explored", "ran"])
  expect(textGroupSummary(parts, "present").map(joined).join(", ")).toBe("Exploring 2 files, 1 search, running 4 commands")
})

test("an edit in a run names its file; several count files", () => {
  const one = [done("edit", { filePath: "/w/pr-body.md", oldString: "", newString: "x" }), done("bash", { command: "ls", description: "List" })]
  expect(textGroupSummary(one, "past").map(joined).join(", ")).toBe("Edited pr-body.md, ran 1 command")
  const two = [done("edit", { filePath: "/w/a.md" }), done("write", { filePath: "/w/b.md", content: "" })]
  expect(textGroupSummary(two, "past").map(joined).join(", ")).toBe("Edited 2 files")
})

test("diff sizes come from the engine when reported, otherwise from the change itself", () => {
  const reported = done("edit", { filePath: "/w/a.md", oldString: "a", newString: "b" }, { openwork: { diffStats: { added: 11, removed: 2 } } })
  expect(textDiffStats(reported)).toEqual({ added: 11, removed: 2 })
  const edit = done("edit", { filePath: "/w/a.md", oldString: "one\ntwo\nthree\n", newString: "one\n2\nthree\nfour\n" })
  expect(textDiffStats(edit)).toEqual({ added: 2, removed: 1 })
  const write = done("write", { filePath: "/w/b.md", content: "a\nb\nc\n" })
  expect(textDiffStats(write)).toEqual({ added: 3, removed: 0 })
  expect(textDiffStats(failed("edit", { filePath: "/w/a.md", oldString: "a", newString: "b" }))).toBeNull()
  expect(textDiffStats(done("read", { filePath: "/w/a.md" }))).toBeNull()
  expect(textGroupDiffStats([edit, write, done("bash", { command: "ls" })])).toEqual({ added: 5, removed: 1 })
  expect(textGroupDiffStats([done("bash", { command: "ls" })])).toBeNull()
})

test("thoughts say how long they took, or briefly, and never invent a duration", () => {
  expect(textThoughtLabel(12_000, false)).toBe("Thought 12s")
  expect(textThoughtLabel(800, false)).toBe("Thought briefly")
  expect(textThoughtLabel(null, false)).toBe("Thought")
  expect(textThoughtLabel(12_000, true)).toBe("Thinking")
  expect(reasoningDurationMs({ opencode: { partId: "p", time: { start: 1_000, end: 13_000 } } })).toBe(12_000)
  expect(reasoningDurationMs({ opencode: { partId: "p" } })).toBeNull()
  expect(reasoningDurationMs(undefined)).toBeNull()
})

test("capability sentences split into verb and object, keeping a negation with its verb", () => {
  expect(splitSentence("Looked up people in your organization")).toEqual({ verb: "Looked up", object: "people in your organization" })
  expect(splitSentence("Couldn't remove the group")).toEqual({ verb: "Couldn't remove", object: "the group" })
  expect(splitSentence("Searched your chats for “pricing”")).toEqual({ verb: "Searched", object: "your chats for “pricing”" })
  expect(splitSentence("Ran")).toEqual({ verb: "Ran", object: "" })
  expect(sentenceCase("  move gh credentials ")).toBe("Move gh credentials")
})

test("a command line splits into its program and the rest", () => {
  expect(commandProgram("gh pr view 5245 --repo different-ai/openwork")).toEqual({ program: "gh", rest: " pr view 5245 --repo different-ai/openwork" })
  expect(commandProgram("CI=1 pnpm test")).toEqual({ program: "CI=1 pnpm", rest: " test" })
})

test("GitHub pull request and issue links are recognised; other links are not", () => {
  expect(parseGitHubReference("https://github.com/different-ai/openwork/pull/5212")).toEqual({ owner: "different-ai", repo: "openwork", kind: "pull", number: 5212 })
  expect(parseGitHubReference("https://github.com/different-ai/openwork/issues/12#issuecomment-1")).toEqual({ owner: "different-ai", repo: "openwork", kind: "issue", number: 12 })
  expect(parseGitHubReference("https://github.com/different-ai/openwork")).toBeNull()
  expect(parseGitHubReference("https://example.com/a/b/pull/1")).toBeNull()
})
