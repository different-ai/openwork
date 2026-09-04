import { expect, test } from "bun:test";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client } from "../src/app/types";
import {
  fetchProviderList,
  getConnectedProviderSnapshotChange,
} from "../src/react-app/infra/provider-list-query";
import {
  MAX_TRACKED_MESSAGE_ROLES,
  useSessionActivityStore,
} from "../src/react-app/domains/session/status/session-activity-store";
import { createVoiceRuntime, initialVoiceRuntimeSnapshot, VOICE_TIMELINE_LIMIT } from "../src/react-app/domains/session/voice/voice-runtime";

test("session activity message-role tracking stays bounded per session", () => {
  const store = useSessionActivityStore.getState();
  store.setRunStatus("ws-bounded", "session-a", "busy");
  for (let index = 0; index < MAX_TRACKED_MESSAGE_ROLES + 50; index += 1) {
    store.markMessageRole("ws-bounded", "session-a", `message-${index}`, index % 2 === 0 ? "user" : "assistant");
  }

  const record = useSessionActivityStore.getState().recordsByWorkspaceId["ws-bounded"]?.["session-a"];
  expect(record).toBeDefined();
  // The dict is capped at the most recent marks: the oldest overflowed
  // message ids are dropped, the newest are retained with their roles.
  expect(Object.keys(record?.messageRoles ?? {})).toHaveLength(MAX_TRACKED_MESSAGE_ROLES);
  expect(record?.messageRoles["message-0"]).toBeUndefined();
  expect(record?.messageRoles["message-49"]).toBeUndefined();
  expect(record?.messageRoles["message-50"]).toBe("user");
  expect(record?.messageRoles[`message-${MAX_TRACKED_MESSAGE_ROLES + 49}`]).toBe("assistant");

  // Assistant-output gating still works for a retained assistant message.
  store.markAssistantOutput("ws-bounded", "session-a", `message-${MAX_TRACKED_MESSAGE_ROLES + 49}`);
  expect(
    useSessionActivityStore.getState().recordsByWorkspaceId["ws-bounded"]?.["session-a"]?.assistantOutput,
  ).toBe(true);

  // Negative half: below the cap nothing is evicted.
  store.setRunStatus("ws-small", "session-b", "busy");
  for (let index = 0; index < 10; index += 1) {
    store.markMessageRole("ws-small", "session-b", `small-${index}`, "assistant");
  }
  const smallRecord = useSessionActivityStore.getState().recordsByWorkspaceId["ws-small"]?.["session-b"];
  expect(Object.keys(smallRecord?.messageRoles ?? {})).toHaveLength(10);
  expect(smallRecord?.messageRoles["small-0"]).toBe("assistant");
});

test("connected provider snapshot cache evicts the oldest workspace keys", async () => {
  const emptyProviderList: ProviderListResponse = { all: [], connected: [], default: {} };
  // Only provider.list is exercised by fetchProviderList; a full Client cannot
  // be constructed in a unit spec.
  const client = {
    provider: { list: async () => ({ data: emptyProviderList }) },
  } as unknown as Client;

  for (let index = 0; index < 20; index += 1) {
    await fetchProviderList({ client, baseUrl: "http://localhost:1", directory: `/tmp/workspace-${index}` });
  }

  // 20 distinct (baseUrl, directory) keys were recorded against a cap of 16:
  // the oldest keys are gone, the newest are retained.
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-0" })).toBeNull();
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-3" })).toBeNull();
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-4" })).not.toBeNull();
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-19" })).not.toBeNull();

  // Re-recording an existing key refreshes its recency instead of
  // double-counting it: nothing else is evicted.
  await fetchProviderList({ client, baseUrl: "http://localhost:1", directory: "/tmp/workspace-4" });
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-4" })).not.toBeNull();
  expect(getConnectedProviderSnapshotChange({ baseUrl: "http://localhost:1", directory: "/tmp/workspace-5" })).not.toBeNull();
});

test("voice runtimes are isolated, bounded, and release their transcript", () => {
  const first = createVoiceRuntime();
  const second = createVoiceRuntime();
  for (let index = 0; index < VOICE_TIMELINE_LIMIT + 30; index += 1) first.append("assistant", `spoken line ${index}`);
  expect(first.getSnapshot().entries).toHaveLength(VOICE_TIMELINE_LIMIT);
  expect(first.getSnapshot().entries[0]?.text).toBe("spoken line 30");
  expect(second.getSnapshot().entries).toHaveLength(0);
  first.append("user", "   ");
  expect(first.getSnapshot().entries).toHaveLength(VOICE_TIMELINE_LIMIT);
  first.reset();
  expect(first.getSnapshot()).toEqual(initialVoiceRuntimeSnapshot);
});
