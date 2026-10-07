import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { workbotConversations } from "../worlds/workbot-conversations.ts";

const test = spec.world(workbotConversations, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 900_000 });
const composer = { label: "Message Workbot" };
const unreachable = "I couldn't reach the AI model just now.";

type World = Awaited<ReturnType<typeof workbotConversations>>;

/** Opens the chats list; it slides in from the left, so the screenshot waits until it is all in view. */
async function openChats({ user, probe }: { user: User; probe: Probe }) {
  await user.click({ role: "button", label: "Chats" });
  await probe.eventually(async () => (await probe.dom('[role="dialog"]')).elements.some((element) => element.rect.width > 0 && element.rect.left >= 0), {
    within: 5_000,
    label: "The chats list is in view",
  });
}

/** Past the welcome, in the main chat, with Workbot's hello on screen. */
async function startChatting({ world, user, probe }: { world: World; user: User; probe: Probe }) {
  await user.navigate(world.url);
  await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Get started"), { within: 30_000, label: "The connection choice is ready" });
  await user.click("Get started");
  await user.click("Start chatting");
  await user.see({ text: world.hello }, { timeoutMs: 60_000 });
  await user.see(composer, { editable: true });
}

test("a member's long conversation keeps answering after it outgrows what the model can see", async ({ world, user, probe, step, evidence }) => {
  await step("given a member in their main chat, which Workbot can only see 12,000 characters of", async () => {
    await startChatting({ world, user, probe });
    evidence.recordAssertionEvidence("The member's main chat has started", "Workbot's hello is on screen; the runner keeps 12,000 characters of the conversation in view.", true);
  });
  await step("when the member sends seven notes, and Workbot saves each one with a long draft", async () => {
    for (let index = 1; index <= world.notes; index += 1) {
      await user.type(composer, world.note(index));
      await user.click({ role: "button", label: "Send" });
      await user.see({ text: `Saved note ${index} to your planning notes.` }, { timeoutMs: 60_000 });
    }
    const seen = world.witness();
    evidence.recordAssertionEvidence("Every note was answered", `${seen.noteAnswers} of ${world.notes} notes saved, each after two tool calls`, seen.noteAnswers === world.notes);
    expect(seen.noteAnswers).toBe(world.notes);
  });
  await step("then the conversation had outgrown what the model sees", async () => {
    await user.see({ text: `Saved note ${world.notes} to your planning notes.` });
    const seen = world.witness();
    // The witness: without it, a pass could mean the conversation never got long enough to be cut.
    evidence.recordAssertionEvidence("The model stopped seeing the start of the conversation", `${seen.windowed} model requests no longer included the hello`, seen.windowed > 0);
    expect(seen.windowed).toBeGreaterThan(0);
  });
  await step("after: no request broke the model's rules, and no answer failed", async () => {
    await user.notSee({ text: unreachable });
    const seen = world.witness();
    evidence.recordAssertionEvidence(
      "The model refused no request",
      seen.refused === 0 ? `0 of ${seen.requests} requests refused; every tool result followed its call` : `${seen.refused} refused: ${seen.lastRefusal}`,
      seen.refused === 0,
    );
    expect(seen.refused).toBe(0);
    await user.screenshot();
  });
});

test("a member tries a failed answer again and Workbot answers that same message once", async ({ world, user, probe, step, evidence }) => {
  await step("given a member in their main chat", async () => {
    await startChatting({ world, user, probe });
    evidence.recordAssertionEvidence("The member's main chat has started", "Workbot's hello is on screen.", true);
  });
  await step("before: the model fails three times on the member's question, and the answer fails", async () => {
    await user.type(composer, world.flaky);
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: unreachable }, { timeoutMs: 60_000 });
    await user.see({ role: "button", text: "Try again" });
    const seen = world.witness();
    evidence.recordAssertionEvidence("The answer failed after the runner's own retries", `the model failed ${seen.flakyFailures} times; the page offers Try again`, seen.flakyFailures === 3);
    expect(seen.flakyFailures).toBe(3);
    await user.screenshot();
  });
  await step("when the member clicks Try again", async () => {
    await user.click({ role: "button", text: "Try again" });
    await user.see({ text: world.flakyAnswer }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("Workbot answered", world.flakyAnswer, true);
  });
  await step("after: the question is on the page once, and the model saw it once", async () => {
    await user.notSee({ text: unreachable });
    const copies = (await probe.text()).split(world.flaky).length - 1;
    const seen = world.witness();
    evidence.recordAssertionEvidence("One copy of the question", `on the page: ${copies}; in the model's request: ${seen.flakyCopies}`, copies === 1 && seen.flakyCopies === 1);
    expect(copies).toBe(1);
    expect(seen.flakyCopies).toBe(1);
    await user.screenshot();
  });
});

test("a member starts a side chat for one topic, and their main chat remembers what it learned", async ({ world, user, probe, step, evidence }) => {
  await step("before: the member's chats list has only their main chat", async () => {
    await startChatting({ world, user, probe });
    await openChats({ user, probe });
    await user.see({ text: "Main chat" });
    await user.see({ text: "No side chats yet." });
    await user.screenshot();
    evidence.recordAssertionEvidence("No side chats yet", "The list shows the main chat and an empty side chats section with New side chat.", true);
  });
  await step("the member starts a side chat and Workbot names it after its first answer", async () => {
    await user.click({ role: "button", label: "New side chat" });
    await user.see({ role: "heading", text: "New side chat" });
    await user.type(composer, world.side);
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: world.sideAnswer }, { timeoutMs: 60_000 });
    await user.see({ role: "heading", text: world.sideTitle }, { timeoutMs: 30_000 });
    const seen = world.witness();
    evidence.recordAssertionEvidence("The side chat has its own name and saved what it learned", `named "${world.sideTitle}" after ${seen.titleRequests} naming request; memory saved: ${seen.sideSavedMemory}`, seen.sideSavedMemory);
    expect(seen.sideSavedMemory).toBe(true);
    await user.screenshot();
  });
  await step("back in the main chat, the side chat stays out of it, and what it learned is remembered", async () => {
    await user.click({ role: "button", label: "Back to main chat" });
    await user.see({ text: world.hello });
    await user.notSee({ text: world.side });
    expect(JSON.stringify(await world.thread())).not.toContain(world.side);
    await user.type(composer, world.recall);
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: world.recallAnswer }, { timeoutMs: 60_000 });
    const seen = world.witness();
    evidence.recordAssertionEvidence("The main chat shares the side chat's memory, not its messages", `main chat shows no side chat message; its model saw the saved fact: ${seen.mainSawSideMemory}`, seen.mainSawSideMemory);
    expect(seen.mainSawSideMemory).toBe(true);
    await user.screenshot();
  });
  await step("after: the chats list shows the side chat by its name", async () => {
    await openChats({ user, probe });
    await user.see({ text: world.sideTitle });
    const chats: unknown = await world.chats();
    const listed = JSON.stringify(chats);
    evidence.recordAssertionEvidence("The side chat is listed", listed.slice(0, 200), listed.includes(world.sideTitle));
    expect(listed).toContain(world.sideTitle);
    await user.screenshot();
  });
});
