import { expect, test } from "bun:test";
import type { ToolApproval } from "@openwork/types/den/tool-permissions";

import { approvalsForSurface, approvalWords } from "../src/react-app/domains/tool-approvals/tool-approval-words";

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
