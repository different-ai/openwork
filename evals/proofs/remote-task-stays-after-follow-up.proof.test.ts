import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  CHAT_PROMPT, CHAT_REPLY, COMPUTER_LABEL, FOLLOW_UP, FOLLOW_UP_CHAT_PROMPT, FOLLOW_UP_CHAT_REPLY, TASK_TITLE,
  remoteSessionFollowUpWorld,
} from "../worlds/remote-session-helper-view.ts";

const test = spec.world(remoteSessionFollowUpWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 600_000,
});

const AGENTS = "[data-subagent-tracker]";
const AGENT_ROW = "[data-subagent-tracker-remote]";

test("a member who asks a running task on their other computer for more work still sees it in the Agents list, as one row, after the chat goes quiet and after a reload", async ({ world, user, probe, step, evidence }) => {
  const texts = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text);
  const send = async (prompt: string) => {
    await user.see("composer", { editable: true, timeoutMs: 30_000 });
    await user.type("composer", prompt);
    await probe.eventually(() => probe.dom('button[aria-label="Run task"]:not(:disabled)'), {
      within: 30_000, label: "the conversation is ready to send", until: (value) => value.elements.length === 1,
    });
    await user.click("Run task");
  };
  const createCalls = async () => (await world.mock.toolCalls({ name: "execute_capability" })).filter((call) => call.args.name === "remote-session:create").length;
  const sendCalls = async () => (await world.mock.toolCalls({ name: "execute_capability" })).filter((call) => call.args.name === "remote-session:send").length;

  await step("given: the chat hands the demo videos to the member's other computer, and the Agents list shows it working", async () => {
    await send(CHAT_PROMPT);
    await user.see({ text: CHAT_REPLY }, { timeoutMs: 120_000 });
    const rows = await probe.eventually(() => texts(AGENT_ROW), {
      within: 60_000, label: "the Agents list shows the task", until: (value) => value.length === 1 && (value[0] ?? "").includes("Working"),
    });
    const ok = (rows[0] ?? "").startsWith(COMPUTER_LABEL) && (rows[0] ?? "").includes(TASK_TITLE);
    evidence.recordAssertionEvidence("One row: where it runs, the task and Working", `rows: ${JSON.stringify(rows)}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after: the member asks for more work on the next turn; the chat goes quiet and the task is still listed, once, working", async () => {
    await send(FOLLOW_UP_CHAT_PROMPT);
    await user.see({ text: FOLLOW_UP_CHAT_REPLY }, { timeoutMs: 120_000 });
    await probe.eventually(() => probe.dom('button[aria-label="Run task"]'), {
      within: 30_000, label: "the chat's own turn has ended", until: (value) => value.elements.length === 1,
    });
    // Captured before the check so a red run still shows what the person saw.
    await user.screenshot();
    const rows = await probe.eventually(() => texts(AGENT_ROW), {
      within: 30_000, label: "the task is still in the Agents list", until: (value) => value.length >= 1,
    }).catch(() => [] as string[]);
    const header = (await texts(`${AGENTS} [data-subagent-tracker-summary]`))[0] ?? "";
    const creates = await createCalls();
    const sends = await sendCalls();
    const ok = rows.length === 1 && (rows[0] ?? "").startsWith(COMPUTER_LABEL) && (rows[0] ?? "").includes(TASK_TITLE) && (rows[0] ?? "").includes("Working")
      && header === "1 working" && creates === 1 && sends === 1 && world.followUps().includes(FOLLOW_UP);
    evidence.recordAssertionEvidence("Exactly one row for the same task, still Working with the chat idle; the follow-up was sent and nothing new was started",
      `rows: ${JSON.stringify(rows)}; header: ${JSON.stringify(header)}; tasks started: ${creates}; follow-ups sent: ${sends}; the computer received: ${JSON.stringify(world.followUps())}`, ok);
    expect(ok).toBe(true);
  });

  await step("after a reload: reopening the chat finds the task still working and lists it again", async () => {
    await user.reload();
    await user.see({ text: FOLLOW_UP_CHAT_REPLY }, { timeoutMs: 60_000 });
    const rows = await probe.eventually(() => texts(AGENT_ROW), {
      within: 60_000, label: "the reopened chat lists the task", until: (value) => value.length === 1 && (value[0] ?? "").includes("Working"),
    });
    const ok = rows.length === 1 && (rows[0] ?? "").includes(TASK_TITLE);
    evidence.recordAssertionEvidence("One row again after reopening, from the task's live state", `rows: ${JSON.stringify(rows)}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("boundary: once the member stops the task, the quiet chat's Agents list goes away", async () => {
    await user.click({ role: "button", label: `${TASK_TITLE}. Stop the task` });
    const received = await probe.eventually(() => world.stops(), {
      within: 60_000, label: "the other computer stopped the task", until: (value) => value.length === 1,
    });
    const lists = await probe.eventually(async () => (await probe.dom(AGENTS)).elements.length, {
      within: 60_000, label: "the Agents list goes away", until: (value) => value === 0,
    });
    const ok = received.length === 1 && lists === 0;
    evidence.recordAssertionEvidence("One stop reached the computer, and a settled list does not linger", `stops: ${received.length}; Agents lists on screen: ${lists}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
