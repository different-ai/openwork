import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  CHAT_PROMPT, CHAT_REPLY, CHAT_TITLE, COMPUTER_LABEL, DRAFT, LATEST_STEP, PARENT_DRAFT, STEER, TASK_PROMPT, TASK_TITLE,
  remoteSessionHelperViewWorld,
} from "../worlds/remote-session-helper-view.ts";

const test = spec.world(remoteSessionHelperViewWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 600_000,
});

const SURFACE = "[data-remote-session-surface]";
const ROW = "[data-remote-thread]";

test("a member opens a task running on their other computer like a helper, steers it with Enter, returns with Esc where they left off, and stops it", async ({ world, user, probe, step, evidence }) => {
  const texts = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text);

  await step("the member's chat hands the demo videos to their other computer, and the row says what it is doing", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", CHAT_PROMPT);
    await probe.eventually(() => probe.dom('button[aria-label="Run task"]:not(:disabled)'), {
      within: 30_000, label: "the conversation is ready to run the task", until: (value) => value.elements.length === 1,
    });
    await user.click("Run task");
    await user.see({ text: CHAT_REPLY }, { timeoutMs: 120_000 });
    const rows = await probe.eventually(() => texts(ROW), {
      within: 60_000, label: "the task's row says what it ran last", until: (value) => value.length === 1 && (value[0] ?? "").includes(LATEST_STEP),
    });
    const row = rows[0] ?? "";
    const sidebar = await probe.eventually(() => texts("[data-sidebar-remote-task]"), {
      within: 30_000, label: "the task is listed under its chat", until: (value) => value.some((text) => text.includes(TASK_TITLE)),
    });
    const ok = row.startsWith(`Working on ${COMPUTER_LABEL} · ${TASK_TITLE}`) && row.includes(`last ran: ${LATEST_STEP}`)
      && sidebar.some((text) => text.includes("Working"));
    evidence.recordAssertionEvidence("The row reads as one sentence with the step it ran last; the sidebar nests it under the chat with a word", `row: ${JSON.stringify(row)}; sidebar: ${JSON.stringify(sidebar)}`, ok);
    expect(ok).toBe(true);
    await user.type("composer", PARENT_DRAFT);
    await user.screenshot();
  });

  await step("after: clicking the row opens the task in the main pane, with the chat as its breadcrumb and the task folded to one line", async () => {
    await user.click({ label: new RegExp(`${TASK_TITLE}\\. Open the task on`) });
    await user.see({ label: "Follow up" }, { editable: true, timeoutMs: 30_000 });
    const route = decodeURIComponent(await probe.hash());
    const breadcrumb = await texts("[data-remote-session-header]");
    const brief = await texts("[data-remote-session-brief]");
    const focused = (await probe.dom(`${SURFACE} textarea`)).elements.some((element) => element.focused);
    const ok = route.includes(`remote:command:${world.commandId}`)
      && (breadcrumb[0] ?? "").includes(CHAT_TITLE) && (breadcrumb[0] ?? "").includes(TASK_TITLE) && (breadcrumb[0] ?? "").includes("Open beside")
      && (brief[0] ?? "").startsWith(`Task ${TASK_PROMPT.slice(0, 20)}`) && focused;
    evidence.recordAssertionEvidence("The task has its own route and header, and the follow-up box is ready to type in",
      `route: ${route}; header: ${JSON.stringify(breadcrumb)}; folded task: ${JSON.stringify(brief)}; box focused: ${focused}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("Enter steers the running task: the other computer receives the follow-up", async () => {
    await user.type({ label: "Follow up" }, STEER);
    await user.press("Enter");
    const received = await probe.eventually(() => world.followUps(), {
      within: 60_000, label: "the other computer received the follow-up", until: (value) => value.includes(STEER),
    });
    await user.see({ text: STEER }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The other computer's session received exactly what was typed", `follow-ups received: ${JSON.stringify(received)}`, received.length === 1 && received[0] === STEER);
    expect(received).toEqual([STEER]);
    await user.screenshot();
  });

  await step("Esc returns to the chat with its own draft and the task's row in place", async () => {
    await user.type({ label: "Follow up" }, DRAFT);
    await user.press("Escape");
    await user.see({ text: CHAT_REPLY }, { timeoutMs: 30_000 });
    await user.see("composer", { value: PARENT_DRAFT, timeoutMs: 15_000 });
    const route = decodeURIComponent(await probe.hash());
    const rows = await texts(ROW);
    const ok = route.includes(world.session.sessionId) && !route.includes("remote:") && rows.length === 1;
    evidence.recordAssertionEvidence("Back on the chat that started the task, with the chat's draft kept", `route: ${route}; chat draft: ${JSON.stringify(PARENT_DRAFT)}; rows: ${rows.length}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("reopening the task keeps what was typed there", async () => {
    await user.click({ label: new RegExp(`${TASK_TITLE}\\. Open the task on`) });
    await user.see({ label: "Follow up" }, { value: DRAFT, timeoutMs: 30_000 });
    const route = decodeURIComponent(await probe.hash());
    const ok = route.includes(`remote:command:${world.commandId}`) && world.followUps().length === 1;
    evidence.recordAssertionEvidence("The unsent follow-up is still in the box and was never sent", `draft shown: ${JSON.stringify(DRAFT)}; follow-ups sent: ${world.followUps().length}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after: the round button stops just this task, on its computer", async () => {
    await user.click({ role: "button", label: "Stop" });
    const stops = await probe.eventually(() => world.stops(), {
      within: 60_000, label: "the other computer stopped the task", until: (value) => value.length === 1,
    });
    await probe.eventually(() => texts(`${SURFACE} [data-remote-thread-status]`), {
      within: 60_000, label: "the task says it stopped", until: (value) => value.some((text) => text.includes("Stopped")),
    });
    const status = await texts(`${SURFACE} [data-remote-thread-status]`);
    const ok = stops.length === 1 && status.some((text) => text.includes("Stopped"));
    evidence.recordAssertionEvidence("One stop reached the other computer and the task reads Stopped", `stops: ${JSON.stringify(stops)}; status: ${JSON.stringify(status)}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
