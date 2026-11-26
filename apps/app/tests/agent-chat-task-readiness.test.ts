import { expect, test } from "bun:test";

import { taskCreateBlocker } from "../src/react-app/shell/task-create-readiness";

const connected = {
  agentChat: true,
  hasWorkspace: true,
  hasEndpointToken: true,
  refreshingWorkspaces: false,
  loadingSessionList: false,
};

test("a connected workspace can start an agent chat while its existing chats load", () => {
  expect(taskCreateBlocker({ ...connected, loadingSessionList: true })).toBeNull();
  expect(taskCreateBlocker({ ...connected, loadingSessionList: true, refreshingWorkspaces: true })).toBeNull();
});

test("agent chat creation still requires a known workspace and credentials", () => {
  expect(taskCreateBlocker({ ...connected, hasWorkspace: false })).toBe("missing_workspace");
  expect(taskCreateBlocker({ ...connected, hasEndpointToken: false })).toBe("disconnected");
  expect(taskCreateBlocker({ ...connected, hasEndpointToken: false, refreshingWorkspaces: true })).toBe("loading");
});

test("ordinary task creation retains its readiness checks", () => {
  expect(taskCreateBlocker({ ...connected, agentChat: false, loadingSessionList: true })).toBe("loading");
  expect(taskCreateBlocker({ ...connected, agentChat: false, refreshingWorkspaces: true })).toBe("loading");
});
