import { browserScript, reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export async function manualTaskOrdering(seed: Seed) {
  return taskOrdering(seed, false);
}

export async function groupedTaskOrdering(seed: Seed) {
  return taskOrdering(seed, true);
}

async function taskOrdering(seed: Seed, grouped: boolean) {
  const prompt = "Plan the next task";
  const reply = "The next task is ready.";
  const followup = "Check this task again";
  const followupReply = "The task has been checked.";
  const workspacePath = seed.tmpPath("task-ordering");
  const app = await seed.appWeb({
    name: grouped ? "grouped-task-ordering" : "manual-task-ordering", workspacePath,
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
      { promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] },
      { promptMarker: followup, latestUserTurn: true, finalReply: followupReply, steps: [] },
    ] }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing task ordering model witness");
  // An unloaded workspace's saved order must survive edits to the open list.
  const otherWorkspace = { workspaceId: "ws_unloaded_ordering" };
  const otherSessions = [{ sessionId: "other-task-1" }, { sessionId: "other-task-2" }];
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "ordering-mock", "ordering-model", {
    provider: { "ordering-mock": {
      npm: "@ai-sdk/openai-compatible", name: "Task ordering mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-ordering-fixture" },
      models: { "ordering-model": { name: "Task ordering model" } },
    } },
  });
  const sessions = await seed.sessions(app, Array.from({ length: 8 }, (_, index) => `Task ${index + 1}`));
  const pinned = await seed.session(app, { title: "Pinned reference" });
  // Reproduce an existing user's persisted manual order, including tasks hidden
  // behind Show more. There is no seed primitive for this local preference.
  const groups = grouped ? [{ id: "grp_tasks", label: "Planned tasks" }, { id: "grp_other", label: "Other tasks" }] : [];
  const assignments = grouped ? Object.fromEntries(sessions.map(session => [session.sessionId, "grp_tasks"])) : {};
  await seed.evalIn(app, browserScript(async (workspaceId, ids, pinnedId, otherWorkspaceId, otherIds, groups, assignments) => {
    if (groups.length) {
      const response = await fetch(`http://127.0.0.1:${localStorage.getItem("openwork.server.port")}/workspace/${workspaceId}/session-groups`, {
        method: "PUT", headers: { Authorization: `Bearer ${localStorage.getItem("openwork.server.token")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: { groups, assignments } }),
      });
      if (!response.ok) throw new Error(`Group arrangement failed: ${response.status}`);
    }
    localStorage.setItem("openwork.react.sessionManagement", JSON.stringify({ version: 0, state: {
      pinnedIds: [pinnedId], unreadIds: [], orderByWorkspace: { [workspaceId]: ids, [otherWorkspaceId]: otherIds },
      groupsByWorkspace: { [workspaceId]: { groups, assignments } },
    } }));
  }, [workspace.workspaceId, sessions.map(session => session.sessionId), pinned.sessionId,
    otherWorkspace.workspaceId, otherSessions.map(session => session.sessionId), groups, assignments]));
  await reload(app);
  return { app, workspace, sessions, pinned, prompt, reply, followup, followupReply, otherWorkspace, otherSessions };
}
