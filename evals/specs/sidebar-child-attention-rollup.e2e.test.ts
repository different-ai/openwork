import { expect } from "vitest";
import { browserScript } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { parentChildHeldToolWorld, parentChildPermissionWorld } from "../worlds/first-run.ts";

// A delegated child's pending permission lives on the child's activity
// record. The parent row must show the orange "needs you" dot naming that
// child, not the working spinner, and agents asking list_sessions must see
// the parent as waiting. Answering the request returns the spinner.

const test = spec.world(parentChildPermissionWorld);

const CHILD_TITLE = "Investigate the deployment failure";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("a delegated child's pending permission turns the parent's sidebar row orange and its agent-visible status to waiting", async ({ world, user, agent, probe, step }) => {
  const parentId = world.session.sessionId;
  // TODO(primitive): read a sidebar row's indicator through a first-class primitive.
  const rowIndicator = () => probe.eval(browserScript((id) => {
    const row = document.querySelector<HTMLElement>('[data-sidebar-session-id="' + id + '"]');
    const dot = row?.querySelector<HTMLElement>("[data-session-attention-indicator]");
    return {
      spinner: Boolean(row?.querySelector<HTMLElement>("[data-session-loading-indicator]")),
      dot: dot instanceof HTMLElement ? { title: dot.title, ariaLabel: dot.getAttribute("aria-label"), source: dot.dataset.sessionAttentionSource ?? null } : null,
      ariaLabel: row?.querySelector<HTMLElement>('[data-testid="sidebar-session-' + id + '"]')?.getAttribute("aria-label") ?? null,
    };
  }, [parentId]));
  const listedParent = async () => {
    const listed = await agent.run("session.list_sessions");
    if (!Array.isArray(listed)) throw new Error("list_sessions did not return a list");
    return listed.find((entry) => isRecord(entry) && entry.sessionId === parentId);
  };

  await step("the parent row needs you and names the blocked child while the transcript shows the same request", async () => {
    await user.see({ text: /Needs permission/ }, { timeoutMs: 30_000 });
    await user.see({ text: new RegExp(`Requested by ${CHILD_TITLE}`) });
    const indicator = await probe.eventually(rowIndicator, {
      within: 15_000, label: "the parent's sidebar row shows the orange needs-you dot for its child",
      until: (value) => value.dot?.source === "child",
    });
    expect(indicator).toEqual({
      spinner: false,
      dot: { title: `Needs permission: ${CHILD_TITLE}`, ariaLabel: `Needs permission: ${CHILD_TITLE}`, source: "child" },
      ariaLabel: expect.stringContaining(`Needs permission: ${CHILD_TITLE}`),
    });
    const parent = await probe.eventually(listedParent, {
      within: 15_000, label: "session.list_sessions reports the parent as waiting",
      until: (entry) => isRecord(entry) && entry.status === "waiting",
    });
    expect(parent).toMatchObject({ sessionId: parentId, status: "waiting", working: true });
    await user.screenshot();
  });

  await step("answering the child's request returns the parent row to the working spinner", async () => {
    await user.click("Allow once");
    await user.notSee({ text: new RegExp(`Requested by ${CHILD_TITLE}`) }, { timeoutMs: 15_000 });
    const indicator = await probe.eventually(rowIndicator, {
      within: 15_000, label: "the parent's sidebar row returns to the working spinner",
      until: (value) => value.spinner && value.dot === null,
    });
    expect(indicator).toMatchObject({ spinner: true, dot: null });
    const parent = await probe.eventually(listedParent, {
      within: 15_000, label: "session.list_sessions reports the parent as working again",
      until: (entry) => isRecord(entry) && entry.status !== "waiting",
    });
    expect(parent).toMatchObject({ sessionId: parentId, status: "thinking", working: true });
    await user.screenshot();
  });
});

const heldToolTest = spec.world(parentChildHeldToolWorld, { timeout: 600_000 });

heldToolTest("an idle parent's sidebar spinner and descendantActivity follow a real child's held MCP tool", { timeout: 240_000 }, async ({ world, user, agent, probe, step }) => {
  const parentId = world.session.sessionId;
  const sinceIso = new Date().toISOString();
  const v2 = world.engine === "v2";
  const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
  const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
  const read = async (path: string) => {
    const response = await probe.desktopApi(world.mount + path);
    expect(response.status, path).toBe(200);
    return v2 ? record(response.body).data : response.body;
  };
  const transcript = async (id: string) => records(await read(`/session/${encodeURIComponent(id)}/${v2 ? "context" : "message?limit=50"}`))
    .flatMap((message) => {
      const info = v2 ? message : record(message.info);
      if (info[v2 ? "type" : "role"] !== "assistant") return [];
      const parts = records(v2 ? message.content : message.parts);
      return [{
        id: info.id, completed: typeof record(info.time).completed === "number",
        text: parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
        tools: parts.filter((part) => part.type === "tool").map((part) => ({
          name: part[v2 ? "name" : "tool"], status: record(part.state).status, metadata: record(part.state).metadata,
        })),
      }];
    });
  const nativeStatuses = async () => {
    const statuses = await read(v2 ? "/session/active" : "/session/status");
    expect(isRecord(statuses) && !Array.isArray(statuses)).toBe(true);
    return record(statuses);
  };
  const statusOf = (statuses: Record<string, unknown>, id: string) => id in statuses ? record(statuses[id]).type : "idle";
  const listedParent = async () => {
    const listed = await agent.run("session.list_sessions");
    expect(Array.isArray(listed)).toBe(true);
    return records(listed).find((entry) => entry.sessionId === parentId);
  };
  const rowIndicator = () => probe.eval(browserScript((id) => {
    const row = document.querySelector<HTMLElement>('[data-sidebar-session-id="' + id + '"]');
    return {
      exists: Boolean(row),
      spinner: Boolean(row?.querySelector("[data-session-loading-indicator]")),
      attention: Boolean(row?.querySelector("[data-session-attention-indicator]")),
    };
  }, [parentId]));
  const childId = await step("real delegation completes and leaves the parent natively idle", async () => {
    await user.type("composer", world.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.reply }, { timeoutMs: 60_000 });
    const children = records(await read("/session?limit=100")).filter((entry) => entry.parentID === parentId);
    expect(children).toHaveLength(1);
    const child = children[0];
    if (!child || typeof child.id !== "string") throw new Error("Real delegation did not create a child session");
    const id = child.id;
    expect(id).not.toBe(parentId);
    await probe.eventually(async () => ({ messages: await transcript(parentId), statuses: await nativeStatuses() }), {
      within: 30_000, label: "the real task completes before independently resuming its child",
      until: ({ messages, statuses }) => messages.some((message) => message.completed && message.text.includes(world.reply))
        && statusOf(statuses, parentId) === "idle" && statusOf(statuses, id) === "idle",
    });
    expect((await transcript(parentId)).flatMap((message) => message.tools)).toContainEqual({
      name: world.delegationTool, status: "completed",
      metadata: expect.objectContaining(v2 ? { sessionID: id } : { sessionId: id }),
    });
    const parent = await probe.eventually(listedParent, {
      within: 15_000, label: "the idle parent initially has no busy descendants",
      until: (entry) => entry?.working === false && record(entry.descendantActivity).busy === 0,
    });
    expect(parent).toMatchObject({ status: "idle", working: false, descendantActivity: { busy: 0 } });
    expect(await rowIndicator()).toEqual({ exists: true, spinner: false, attention: false });
    return id;
  });
  const parentBefore = await transcript(parentId);

  await step("only the resumed child runs while its idle parent shows descendant work", async () => {
    const sent = await agent.desktopApi(`${world.mount}/session/${encodeURIComponent(childId)}/${v2 ? "prompt" : "prompt_async"}`, {
      method: "POST", body: world.promptBody,
    });
    expect(sent.status).toBe(v2 ? 200 : 204);
    await probe.eventually(world.heldTool, {
      within: 45_000, label: "the child's actual MCP response is held at the witness",
      until: (state) => state.held === 1,
    });
    expect(await world.mock.toolCalls({ name: "hold", sinceIso })).toEqual([
      expect.objectContaining({ name: "hold", args: { marker: world.marker } }),
    ]);
    const active = await probe.eventually(async () => ({
      statuses: await nativeStatuses(), messages: await transcript(childId), parent: await listedParent(), indicator: await rowIndicator(),
    }), {
      within: 15_000, label: "native child tool activity rolls up without making the parent engine busy",
      until: ({ statuses, messages, parent, indicator }) => statusOf(statuses, parentId) === "idle"
        && statusOf(statuses, childId) === (v2 ? "running" : "busy")
        && messages.some((message) => message.tools.some((tool) => tool.name === world.toolName && tool.status === "running"))
        && parent?.working === true && record(parent.descendantActivity).busy === 1 && indicator.spinner,
    });
    expect(active.parent).toMatchObject({ sessionId: parentId, working: true, descendantActivity: { busy: 1 } });
    expect(active.indicator).toEqual({ exists: true, spinner: true, attention: false });
    expect(world.heldTool()).toEqual({ held: 1, released: false, timedOut: false, delivered: 0 });
    expect(await transcript(parentId)).toEqual(parentBefore);
    expect(await probe.hash()).toContain(`/session/${parentId}`);
    await user.screenshot();
  });

  await step("explicit release completes the child and clears the parent's spinner and busy inventory", async () => {
    world.release();
    const settled = await probe.eventually(async () => ({
      statuses: await nativeStatuses(), messages: await transcript(childId), parent: await listedParent(), indicator: await rowIndicator(),
    }), {
      within: 45_000, label: "the successful child tool and native idle state clear descendant activity",
      until: ({ statuses, messages, parent, indicator }) => statusOf(statuses, parentId) === "idle" && statusOf(statuses, childId) === "idle"
        && messages.some((message) => message.completed && message.text.includes(world.toolReply))
        && messages.some((message) => message.tools.some((tool) => tool.name === world.toolName && tool.status === "completed"))
        && parent?.working === false && record(parent.descendantActivity).busy === 0 && !indicator.spinner,
    });
    expect(settled.parent).toMatchObject({ sessionId: parentId, status: "idle", working: false, descendantActivity: { busy: 0 } });
    expect(settled.indicator).toEqual({ exists: true, spinner: false, attention: false });
    expect(world.heldTool()).toEqual({ held: 1, released: true, timedOut: false, delivered: 1 });
    expect(await transcript(parentId)).toEqual(parentBefore);
    expect(await probe.hash()).toContain(`/session/${parentId}`);
    await user.screenshot();
  });
});
