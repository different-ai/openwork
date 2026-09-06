import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { parentChildPermissionWorld } from "../worlds/first-run.ts";
import { delegatedQuestionHandoff, permissionStopRecovery } from "../worlds/chat.ts";

const test = spec.world(parentChildPermissionWorld);

test("a parent task surfaces and resolves its child session permission request", async ({ user, probe, step }) => {
  await step("The parent exposes the child request", async () => {
    await user.see({ text: /Needs permission/ }, { timeoutMs: 30_000 });
    await user.see({ text: /Requested by Investigate the deployment failure/ });
    await user.see({ text: /git status --short --branch/ });
    await user.see("Deny");
    await user.see("Allow once");
    await user.see("Allow for session");
    // TODO(primitive): read delegated-task permission treatment state.
    const waiting = await probe.eval(`(() => {
      const row = document.querySelector('[data-subagent-permission="pending"]');
      return {
        activity: row instanceof HTMLElement ? row.dataset.subagentActivity ?? "" : "",
        childSessionId: row instanceof HTMLElement ? row.dataset.subagentSessionId ?? "" : "",
        hasPermissionIcon: Boolean(row?.querySelector('[data-subagent-permission-icon]')),
        hasShimmer: Boolean(row?.querySelector('.ow-text-shimmer')),
      };
    })()`);
    expect(waiting).toMatchObject({ activity: "waiting-permission", hasPermissionIcon: true, hasShimmer: false });
    expect(waiting).toMatchObject({ childSessionId: expect.stringContaining(":eval-child") });
    await user.screenshot();
  });

  await step("Approving clears the blocked state", async () => {
    await user.click("Allow once");
    await user.notSee({ text: /Requested by Investigate the deployment failure/ }, { timeoutMs: 15_000 });
    await user.notSee({ text: /Needs permission/ });
    // TODO(primitive): read resolved delegated-task running treatment state.
    expect(await probe.eval(`({
      permissionPanelVisible: Boolean(document.querySelector('[data-permission-source="child-session"]')),
      waitingIconVisible: Boolean(document.querySelector('[data-subagent-permission="pending"]')),
      runningTreatmentVisible: Boolean(document.querySelector('[data-subagent-activity="shimmer"] .ow-text-shimmer')),
    })`)).toEqual({ permissionPanelVisible: false, waitingIconVisible: false, runningTreatmentVisible: true });
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a native engine object");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a native engine list");
  return value.map(record);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a native engine string");
  return value;
}

const stopTest = spec.world(permissionStopRecovery, { timeout: 600_000 });

stopTest("retry recovery and stopping a permission leave other requests and fresh work intact", async ({ world, user, probe, step }) => {
  const v2 = world.engine === "v2";
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${v2 ? "opencode2/api" : "opencode"}`;
  const read = async (path: string): Promise<unknown> => {
    const result = await probe.desktopApi(`${mount}${path}`);
    expect(result.status, path).toBe(200);
    return v2 ? record(result.body).data : result.body;
  };
  const pending = async (id: string) => records(await read(v2 ? `/session/${id}/permission` : "/permission"))
    .filter((item) => item.sessionID === id);
  const send = async (prompt: string) => { await user.type("composer", prompt, { verify: true }); await user.press("Enter"); };
  const open = async (session: { title: string; sessionId: string }) => {
    await user.click({ text: session.title });
    await probe.eventually(() => probe.hash(), { within: 30_000, label: "the intended conversation is selected",
      until: (hash) => hash.includes(`/session/${session.sessionId}`) });
  };

  await step("a native retry survives active polling and then recovers", async () => {
    await send(world.retry.prompt);
    await user.see({ text: /Rate limited for lifecycle verification/ }, { timeoutMs: 45_000 });
    // Several authoritative reads span the sync poll cadence while the native
    // engine still owns the retry. None is evidence of completion.
    const observingUntil = Date.now() + 1_000;
    do {
      const active = record(await read(v2 ? "/session/active" : "/session/status"));
      expect(active[world.other.sessionId]).toBeDefined();
      await user.see({ text: /Rate limited for lifecycle verification/ });
    } while (Date.now() < observingUntil);
    await user.see({ text: world.retry.reply }, { timeoutMs: 45_000 });
    await user.notSee({ text: /Rate limited for lifecycle verification/ });
    const calls = await world.mock.agentRequests({ promptMarker: world.retry.prompt });
    expect(calls.filter((call) => call.kind === "error")).toHaveLength(1);
    expect(calls.filter((call) => call.kind === "final")).toHaveLength(1);
  });

  const unrelated = await step("two conversations own separate real approvals", async () => {
    await send(world.other.prompt);
    await user.see({ text: world.other.command }, { timeoutMs: 45_000 });
    const other = await probe.eventually(() => pending(world.other.sessionId), { within: 30_000,
      label: "the unrelated approval is pending", until: (items) => items.length === 1 });
    await open(world.stopped);
    await send(world.stopped.prompt);
    await user.see({ text: world.stopped.command }, { timeoutMs: 45_000 });
    expect(await pending(world.stopped.sessionId)).toHaveLength(1);
    expect(await pending(world.other.sessionId)).toEqual(other);
    return other;
  });

  await step("Stop removes its cancelled approval without a permission reply and preserves the other session", async () => {
    await user.click({ role: "button", label: "Stop" });
    await probe.eventually(() => pending(world.stopped.sessionId), { within: 30_000,
      label: "native interruption cleanup removes the pending permission", until: (items) => items.length === 0 });
    await user.notSee("Allow once", { timeoutMs: 15_000 });
    await user.notSee({ role: "button", label: "Stop" });
    if (v2) expect(record(await read(`/session/${world.stopped.sessionId}`)).outcome).toBe("interrupted");
    expect(await pending(world.other.sessionId)).toEqual(unrelated);
    expect((await world.mock.agentRequests({ promptMarker: world.stopped.prompt })).some((call) => call.kind === "final")).toBe(false);
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 45_000 });
    await user.notSee("Allow once");
    expect(await pending(world.other.sessionId)).toEqual(unrelated);
  });

  await step("fresh work completes once and the unrelated approval remains answerable", async () => {
    await send(world.followup.prompt);
    await user.see({ text: world.followup.reply }, { timeoutMs: 45_000 });
    expect((await world.mock.agentRequests({ promptMarker: world.followup.prompt })).filter((call) => call.kind === "final")).toHaveLength(1);
    await open(world.other);
    await user.see("Allow once");
    expect(await pending(world.other.sessionId)).toEqual(unrelated);
    await user.click("Allow once");
    await user.see({ text: "Permission work finished." }, { timeoutMs: 45_000 });
    await user.notSee("Allow once");
    expect(await pending(world.stopped.sessionId)).toEqual([]);
    await user.screenshot();
  });
});

const questionTest = spec.world(delegatedQuestionHandoff, { timeout: 600_000 });
questionTest("a parent answers its real child question without settling an unrelated root question", { timeout: 1_200_000 }, async ({ world, user, probe, step }) => {
  const v2 = world.engine === "v2";
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${v2 ? "opencode2/api" : "opencode"}`;
  const sessionPath = (id: string) => `/session/${encodeURIComponent(id)}`;
  const read = async (path: string): Promise<unknown> => {
    const result = await probe.desktopApi(`${mount}${path}`);
    expect(result.status, path).toBe(200);
    return v2 ? record(result.body).data : result.body;
  };
  const pending = async () => records(await read(v2 ? "/form/request" : "/question"))
    .filter((request) => !v2 || record(request.metadata).kind === "question")
    .map((request) => {
      const tool = record(v2 ? record(request.metadata).tool : request.tool);
      const [question] = records(v2 ? request.fields : request.questions);
      if (!question) throw new Error("Expected a question in the native request");
      return {
        id: text(request.id), sessionID: text(request.sessionID),
        messageID: text(tool.messageID), callID: text(tool[v2 ? "id" : "callID"]),
        question: text(question[v2 ? "description" : "question"]),
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  const transcript = async (id: string) => records(await read(`${sessionPath(id)}/${v2 ? "context" : "message?limit=50"}`))
    .flatMap((message) => {
      const info = v2 ? message : record(message.info);
      if (info[v2 ? "type" : "role"] !== "assistant") return [];
      const parts = records(v2 ? message.content : message.parts);
      return [{
        id: text(info.id), completed: typeof record(info.time).completed === "number",
        text: parts.filter((part) => part.type === "text").map((part) => text(part.text)).join(""),
        tools: parts.filter((part) => part.type === "tool").map((part) => ({
          callID: text(part[v2 ? "id" : "callID"]), name: text(part[v2 ? "name" : "tool"]),
          status: text(record(part.state).status), metadata: record(part.state).metadata,
        })),
      }];
    });
  const open = async (sessionId: string, title: string) => {
    // A pending question replaces the composer. Navigate as a person rather
    // than waiting for the control rail's composer-based readiness check.
    await user.click({ text: title });
    await probe.eventually(() => probe.hash(), {
      within: 30_000, label: "the requested root conversation is selected",
      until: (hash) => hash.includes(`/session/${sessionId}`),
    });
  };
  const send = async (prompt: string) => {
    await user.type("composer", prompt, { verify: true });
    await user.press("Enter");
  };
  const complete = async (id: string, promptMarker: string, tool: string, answer: string, excluded: string) => {
    const state = await probe.eventually(async () => ({
      messages: await transcript(id), calls: await world.mock.agentRequests({ promptMarker }),
    }), {
      within: 60_000, label: `${tool} settles and its session returns the actual answer`,
      until: ({ messages, calls }) => messages.some((message) => message.completed && message.text.includes(answer))
        && messages.some((message) => message.tools.some((part) => part.name === tool && part.status === "completed"))
        && calls.some((call) => call.kind === "final" && call.completedTools === 1),
    });
    const final = state.messages.at(-1);
    expect(final).toMatchObject({ completed: true, text: expect.stringContaining(answer) });
    expect(final?.text).not.toContain(excluded);
    expect(state.calls.filter((call) => call.kind === "tool").map((call) => call.toolName)).toEqual([tool]);
    expect(state.calls.some((call) => call.kind === "error")).toBe(false);
    if (v2) await probe.eventually(() => read(sessionPath(id)), {
      within: 15_000, label: "the native session records successful completion",
      until: (value) => record(value).outcome === "succeeded",
    });
    return state.messages;
  };

  const unrelated = await step("an unrelated root waits for its own answer", async () => {
    await send(world.unrelated.prompt);
    await user.see({ text: world.unrelated.question }, { timeoutMs: 45_000 });
    const requests = await probe.eventually(pending, {
      within: 30_000, label: "the unrelated root owns a real question request",
      until: (items) => items.some((item) => item.sessionID === world.unrelated.sessionId),
    });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("Missing unrelated question");
    expect(request).toMatchObject({ sessionID: world.unrelated.sessionId, question: world.unrelated.question });
    expect(record(await read(sessionPath(request.sessionID))).parentID).toBeUndefined();
    return request;
  });

  const child = await step("the parent displays only its delegated child's question", async () => {
    await open(world.root.sessionId, "Delegated question parent");
    await user.notSee({ text: world.unrelated.question });
    await send(world.root.prompt);
    const requests = await probe.eventually(pending, {
      within: 45_000, label: "the real subagent asks its question",
      until: (items) => items.some((item) => item.question === world.child.question),
    });
    expect(requests).toHaveLength(2);
    expect(requests).toContainEqual(unrelated);
    const request = requests.find((item) => item.question === world.child.question);
    if (!request) throw new Error("Missing child question");
    expect(request.id).not.toBe(unrelated.id);
    expect([world.root.sessionId, unrelated.sessionID]).not.toContain(request.sessionID);
    const owner = record(await read(sessionPath(request.sessionID)));
    const root = record(await read(sessionPath(world.root.sessionId)));
    const other = record(await read(sessionPath(unrelated.sessionID)));
    expect(owner).toMatchObject({ id: request.sessionID, parentID: world.root.sessionId });
    expect(root.parentID).toBeUndefined();
    expect(owner[v2 ? "location" : "directory"]).toEqual(root[v2 ? "location" : "directory"]);
    expect(other[v2 ? "location" : "directory"]).toEqual(root[v2 ? "location" : "directory"]);
    await user.see({ text: world.child.question }, { timeoutMs: 30_000 });
    await user.notSee({ text: world.unrelated.question });
    await user.notSee({ role: "button", label: /^Unrelated outline/ });
    expect(await probe.hash()).toContain(`/session/${world.root.sessionId}`);
    expect((await transcript(request.sessionID)).find((message) => message.id === request.messageID)?.tools)
      .toContainEqual(expect.objectContaining({ callID: request.callID, name: "question", status: "running" }));
    return request;
  });

  await step("reloading the parent restores the same unanswered requests", async () => {
    await user.reload();
    await user.see({ text: world.child.question }, { timeoutMs: 45_000 });
    expect(await probe.hash()).toContain(`/session/${world.root.sessionId}`);
    expect(await pending()).toEqual([child, unrelated].sort((a, b) => a.id.localeCompare(b.id)));
    await user.notSee({ text: world.unrelated.question });
    for (const promptMarker of [world.root.prompt, world.child.prompt, world.unrelated.prompt]) {
      expect((await world.mock.agentRequests({ promptMarker })).some((call) => call.kind === "final")).toBe(false);
    }
    await user.screenshot();
  });

  const finished = await step("answering in the parent resumes the original child and then the parent", async () => {
    await user.click({ role: "button", label: /^Child checklist/ });
    await probe.eventually(pending, {
      within: 30_000, label: "only the original child request is settled",
      until: (items) => items.length === 1 && items[0]?.id === unrelated.id,
    });
    if (v2) {
      expect(await read(`${sessionPath(child.sessionID)}/form/${encodeURIComponent(child.id)}/state`))
        .toEqual({ status: "answered", answer: { q0: world.child.answer } });
      expect(await read(`${sessionPath(unrelated.sessionID)}/form/${encodeURIComponent(unrelated.id)}/state`))
        .toEqual({ status: "pending" });
    }
    const answer = `"${world.child.question}"="${world.child.answer}"`;
    const childFinished = await complete(child.sessionID, world.child.prompt, "question", answer, world.unrelated.answer);
    expect(childFinished.find((message) => message.id === child.messageID)?.tools).toContainEqual(expect.objectContaining({
      callID: child.callID, name: "question", status: "completed", metadata: expect.objectContaining({ answers: [[world.child.answer]] }),
    }));
    const parentFinished = await complete(world.root.sessionId, world.root.prompt, world.delegationTool, answer, world.unrelated.answer);
    expect(parentFinished.flatMap((message) => message.tools)).toContainEqual(expect.objectContaining({
      name: world.delegationTool, status: "completed",
      metadata: expect.objectContaining(v2 ? { sessionID: child.sessionID } : { sessionId: child.sessionID }),
    }));
    await user.see({ text: /User has answered your questions:.*="Child checklist"/ });
    await user.notSee({ role: "button", label: /^Child checklist/ });
    expect(await probe.hash()).toContain(`/session/${world.root.sessionId}`);
    expect(await pending()).toEqual([unrelated]);
    expect((await world.mock.agentRequests({ promptMarker: world.unrelated.prompt })).some((call) => call.kind === "final")).toBe(false);
    expect((await transcript(unrelated.sessionID)).map((message) => message.text).join("\n")).not.toContain(world.child.answer);
    return { parent: parentFinished, child: childFinished };
  });

  await step("the unrelated root remains answerable without changing the parent's result", async () => {
    await open(unrelated.sessionID, "Unrelated question root");
    await user.see({ text: world.unrelated.question });
    await user.notSee({ text: world.child.question });
    await user.click({ role: "button", label: /^Unrelated outline/ });
    await complete(unrelated.sessionID, world.unrelated.prompt, "question", `"${world.unrelated.question}"="${world.unrelated.answer}"`, world.child.answer);
    await user.see({ text: /User has answered your questions:.*="Unrelated outline"/ });
    expect(await pending()).toEqual([]);
    expect(await transcript(world.root.sessionId)).toEqual(finished.parent);
    expect(await transcript(child.sessionID)).toEqual(finished.child);
    await user.screenshot();
  });
});
