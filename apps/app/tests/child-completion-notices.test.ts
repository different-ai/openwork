import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { UIMessage } from "ai";
import { messageNotice, projectedMessageMetadata, readRunActivities, runElapsed, sessionNotice } from "../src/lib/session-run";
import { transcriptProgress } from "../src/react-app/domains/session/status/session-progress";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

afterEach(() => { setSystemTime(); useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} }); });

test("only allowlisted native notices appear and an idle-parent continuation anchors to its notice", () => {
  const native = { source: "subagent", childID: "child", state: "completed", description: "Inspect a fixture" };
  expect(sessionNotice({ source: "instruction", state: "completed" }, "hidden", 1_000)).toBeNull();
  expect(sessionNotice({ source: "subagent", childID: "child", state: "running" }, "hidden", 1_000)).toBeNull();
  const notice = sessionNotice(native, "native-notice", 2_000)!;
  const message: UIMessage = { id: notice.id, role: "assistant", parts: [{ type: "text", text: "Hidden model input", providerMetadata: { opencode: { notice } } }] };
  expect(messageNotice(message)).toEqual(notice);
  setSystemTime(3_000);
  const store = useSessionActivityStore.getState();
  store.observeTranscript("w", "parent", [message]); store.setRunStatus("w", "parent", "busy");
  store.observeTranscript("w", "parent", [message]);
  const record = useSessionActivityStore.getState().recordsByWorkspaceId.w!.parent!;
  expect(record.currentRunId).toBe(notice.id);
  expect(record.runs[notice.id]!.startedAt).toBe(2_000);
  expect(Object.keys(record.runs)).toEqual([notice.id]);
});
test("a native notice during work joins the current run without changing its timer", () => {
  setSystemTime(1_000);
  const store = useSessionActivityStore.getState();
  store.beginRun("notice-w", "parent", "original-prompt", 1_000);
  const notice = sessionNotice({ source: "subagent", childID: "child", state: "completed" }, "notice", 2_000)!;
  const message: UIMessage = { id: notice.id, role: "assistant", parts: [{ type: "text", text: "Native completion", providerMetadata: { opencode: { notice } } }] };
  setSystemTime(3_000); store.observeTranscript("notice-w", "parent", [message]);
  store.observeTranscript("notice-w", "parent", [message]);
  const record = useSessionActivityStore.getState().recordsByWorkspaceId["notice-w"]!.parent!;
  expect(record.currentRunId).toBe("original-prompt");
  expect(record.runs["original-prompt"]!.noticeIds).toEqual(["notice"]);
  expect(runElapsed(record.runs["original-prompt"]!, 4_000)).toBe(3_000);
});
