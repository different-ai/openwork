import { expect, test } from "bun:test";
import type { ToolApproval } from "@openwork/types/den/tool-permissions";

import { automationApprovalResultWords, automationApprovalTarget, approvalsForRun, approvalsForSurface, approvalWords } from "../src/react-app/domains/tool-approvals/tool-approval-words";

const chat: ToolApproval = {
  id: "chat-approval", context: { kind: "chat", id: null, label: null }, runId: null,
  connectionId: "connection", connectionName: "Slack", toolName: "send", toolTitle: "Send a message",
  status: "pending", createdAt: 1,
};
const automation: ToolApproval = {
  ...chat, id: "automation-approval", context: { kind: "automation", id: "automation", label: "Daily digest" },
};

test("chat and Automation display different time scopes for Allow once", () => {
  expect(approvalWords(chat)).toEqual({
    title: "Let OpenWork use Send a message in Slack?",
    line: "Asked from a chat. Allow once lets the next try go through.",
  });
  expect(approvalWords(automation)).toEqual({
    title: "Let Daily digest use Send a message in Slack?",
    line: "Allow once covers its next run.",
  });
});

test("a surface only displays pending approvals for its own context, never for agents", () => {
  const items: ToolApproval[] = [chat, automation,
    { ...chat, id: "allowed", status: "allowed_once" },
    { ...automation, id: "denied", status: "denied" },
    { ...automation, id: "agent", context: { kind: "agent", id: "agent", label: "Bug watcher" } },
  ];
  expect(approvalsForSurface(items, "chat")).toEqual([chat]);
  expect(approvalsForSurface(items, "automation")).toEqual([automation]);
});

test("missing names fall back to plain words rather than internal IDs", () => {
  const unnamed = { ...automation, context: { ...automation.context, label: " " }, toolTitle: "", connectionName: "" };
  expect(approvalWords(unnamed).title).toBe("Let this Automation use a tool in a connected app?");
});

test("an approval appears only on its own Automation and run", () => {
  const pending = { ...automation, runId: "run-one" };
  const otherRun = { ...automation, id: "other-run", runId: "run-two" };
  const otherAutomation = { ...pending, id: "other-automation", context: { ...automation.context, id: "another" } };
  const items: ToolApproval[] = [pending, otherRun, otherAutomation, automation,
    { ...pending, id: "old", status: "denied" },
    { ...chat, runId: "run-one" },
  ];
  expect(approvalsForRun(items, "automation", "run-one")).toEqual([pending]);
  expect(approvalsForRun(items, "automation", "run-two")).toEqual([otherRun]);
  expect(approvalsForRun(items, "another", "run-one")).toEqual([otherAutomation]);
  expect(automationApprovalTarget(pending)).toEqual({ automationId: "automation", runId: "run-one", toolName: "send", connectionName: "Slack" });
  expect(automationApprovalTarget(chat)).toBeNull();
});

test("a decided approval offers the new run only when it started", () => {
  expect(automationApprovalResultWords({ kind: "started", runId: "new-run" }, automation.context)).toEqual({
    line: "Allowed once. Started a new run.", open: { label: "Open it", runId: "new-run" },
  });
  expect(automationApprovalResultWords({ kind: "skipped" }, automation.context)).toEqual({ line: "Allowed once. It covers the next run." });
  expect(automationApprovalResultWords({ kind: "denied" }, automation.context)).toEqual({ line: "Denied." });
  expect(automationApprovalResultWords({ kind: "failed" }, automation.context)).toEqual({ line: "Couldn't start Daily digest. Your approval still covers its next run." });
});
