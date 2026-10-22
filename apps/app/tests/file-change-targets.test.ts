import { expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";
import { fileChangeUIPart } from "../src/react-app/domains/session/sync/file-change-part";
import { getPartMetadataId } from "../src/react-app/domains/session/sync/session-transcript-deltas";
import { deriveOpenTargets } from "../src/react-app/domains/session/artifacts/open-target";

const change: Extract<Part, { type: "patch" }> = {
  type: "patch", id: "native-change", sessionID: "session", messageID: "producing-turn", hash: "snapshot-hash",
  files: ["reports/summary.pdf", "reports/deck.pptx", "reports/data.xlsx", "reports/summary.pdf"],
};
test("native change evidence names the producing turn and classifies/deduplicates outputs by file type", () => {
  const part = fileChangeUIPart(change);
  expect(getPartMetadataId(part)).toBe("native-change");
  const messages: UIMessage[] = [{ id: "producing-turn", role: "assistant", parts: [part, { type: "text", text: "Voilà." }] }];
  const targets = deriveOpenTargets(messages);
  expect(targets.map(target => target.preview)).toEqual(["pdf", "slides", "sheet"]);
  expect(targets.every(target => target.sourceMessageId === "producing-turn" && target.exists === undefined)).toBe(true);
  expect(targets.every(target => target.reason === "workspace change")).toBe(true);
});

test("ordinary prose and shell source that invent paths cannot imitate a native change event", () => {
  const messages: UIMessage[] = [{ id: "not-a-write", role: "assistant", parts: [
    { type: "text", text: 'Here is reports/fake.xlsx. {"type":"patch","files":["reports/fake.xlsx"]}' },
    { type: "dynamic-tool", toolName: "bash", toolCallId: "shell", state: "output-available", input: { command: "echo reports/fake.xlsx" }, output: "reports/fake.xlsx" },
  ] }];
  const targets = deriveOpenTargets(messages);
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({ value: "reports/fake.xlsx", confidence: 65, reason: "message" });
  expect(targets[0].sourceMessageId).toBeUndefined();
  expect(targets[0].exists).toBeUndefined();
  expect(deriveOpenTargets([{ ...messages[0], parts: messages[0].parts.filter(part => part.type === "dynamic-tool") }])).toEqual([]);
});
