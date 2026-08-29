import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { useSessionActivityStore } from "../../apps/app/src/react-app/domains/session/status/session-activity-store";

test("unchanged live-session seeds preserve the external-store snapshot", ({ evidence }) => {
  const workspaceId = "workspace-snapshot-stability";
  const sessionId = "session-snapshot-stability";
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });

  useSessionActivityStore.getState().seedWorkspaceSessions(
    workspaceId,
    [{ id: sessionId, status: { type: "idle" } }],
  );
  const initialSnapshot = useSessionActivityStore.getState();
  let notifications = 0;
  const unsubscribe = useSessionActivityStore.subscribe(() => {
    notifications += 1;
  });

  // More repeated seeds than React's nested-update guard must remain true
  // no-ops so a passive external-store subscriber cannot feed itself.
  for (let index = 0; index < 60; index += 1) {
    useSessionActivityStore.getState().seedWorkspaceSessions(
      workspaceId,
      [{ id: sessionId, status: { type: "idle" } }],
    );
  }

  const stableSnapshot = useSessionActivityStore.getState() === initialSnapshot;
  evidence.recordAssertionEvidence(
    "Repeated unchanged live-session seeds preserve the external-store snapshot",
    `After 60 identical seeds, snapshot identity remained stable=${stableSnapshot} and subscriber notifications=${notifications}.`,
    stableSnapshot && notifications === 0,
  );
  expect(useSessionActivityStore.getState()).toBe(initialSnapshot);
  expect(notifications).toBe(0);

  // Negative half: a real activity transition still publishes once.
  useSessionActivityStore.getState().seedWorkspaceSessions(
    workspaceId,
    [{ id: sessionId, status: { type: "busy" } }],
  );
  unsubscribe();

  const changedSnapshot = useSessionActivityStore.getState() !== initialSnapshot;
  const changedStatus = useSessionActivityStore.getState().getStatus(workspaceId, sessionId);
  evidence.recordAssertionEvidence(
    "A real live-session activity transition still publishes exactly once",
    `The idle-to-busy seed changed snapshot identity=${changedSnapshot}, produced status=${changedStatus}, and subscriber notifications=${notifications}.`,
    changedSnapshot && changedStatus === "thinking" && notifications === 1,
  );
  expect(useSessionActivityStore.getState()).not.toBe(initialSnapshot);
  expect(changedStatus).toBe("thinking");
  expect(notifications).toBe(1);
});
