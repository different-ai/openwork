import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { crossWorkspace } from "../worlds/chat.ts";

const typableBudgetMs = 10_000;

interface Chat {
  workspaceId: string;
  sessionId: string;
  title: string;
}

async function switchTo(user: User, probe: Probe, chat: Chat): Promise<number> {
  const startedAt = Date.now();
  await user.click({ role: "button", label: new RegExp(chat.title) });
  await probe.eventually(async () => {
    const [composer, workspace] = await Promise.all([
      probe.composer(),
      probe.storage("openwork.react.activeWorkspace"),
    ]);
    return {
      ready: composer.composerEditable && composer.runTaskVisible,
      route: composer.route,
      workspace,
    };
  }, {
    within: 30_000,
    intervalMs: 50,
    label: `typable composer in ${chat.title}`,
    until: (state) => state.ready && state.route.includes(chat.sessionId) && state.workspace === chat.workspaceId,
  });
  return Date.now() - startedAt;
}

async function clearComposer(user: User): Promise<void> {
  await user.type("composer", " ", { replace: true });
  await user.press("Backspace");
}

const test = spec.world(crossWorkspace, { timeout: 15 * 60_000 });

test("switching chats across workspaces keeps the composer prompt-ready and drafts isolated", async ({ world, user, probe, step }) => {
  const { A1, A2, B1, B2 } = world.chats;
  const chats = [A1, A2, B1, B2];
  expect(new Set(chats.map((chat) => chat.sessionId)).size).toBe(4);

  const timings: { title: string; ms: number }[] = [];
  await step("every cross-workspace switch reaches a typable composer within budget", async () => {
    const rotation = [B1, A2, B2, A1, B1, A1, B2, A2];
    for (const chat of rotation) timings.push({ title: chat.title, ms: await switchTo(user, probe, chat) });
    expect(Math.max(...timings.map((timing) => timing.ms)), JSON.stringify(timings)).toBeLessThanOrEqual(typableBudgetMs);
  });

  const draftA1 = `draft-a1-${Date.now().toString(36)}`;
  const draftB1 = `draft-b1-${Date.now().toString(36)}`;
  await step("drafts remain isolated per chat", async () => {
    await switchTo(user, probe, A1);
    await user.type("composer", draftA1);
    await switchTo(user, probe, B1);
    const draftSeenInB1 = (await probe.composer()).draftText.trim();
    expect(draftSeenInB1).not.toContain(draftA1);
    await user.type("composer", draftB1);
    await switchTo(user, probe, A1);
    const draftBackInA1 = (await probe.composer()).draftText.trim();
    expect(draftBackInA1).toContain(draftA1);
    expect(draftBackInA1).not.toContain(draftB1);
  });

  await step("keystrokes after a switch never leak into another chat", async () => {
    const eagerMarker = `eager-${Date.now().toString(36)}`;
    await user.click({ role: "button", label: /Chat B2/ });
    await user.type("composer", eagerMarker);
    expect((await probe.composer()).draftText).toContain(eagerMarker);
    await switchTo(user, probe, A1);
    expect((await probe.composer()).draftText).not.toContain(eagerMarker);
    await switchTo(user, probe, B1);
    expect((await probe.composer()).draftText).not.toContain(eagerMarker);
  });

  await step("a cleared draft stays cleared after a round trip", async () => {
    await switchTo(user, probe, A1);
    await clearComposer(user);
    await user.see("composer", { text: "" });
    await switchTo(user, probe, B2);
    await switchTo(user, probe, A1);
    expect((await probe.composer()).draftText.trim()).toBe("");
  });

  await step("send after a switch contains only the new prompt and clears the composer", async () => {
    await switchTo(user, probe, B2);
    await clearComposer(user);
    const prompt = `Reply with the completion for ${world.sendMarker}.`;
    await user.type("composer", prompt);
    await user.click("Run task");
    // TODO(primitive): read the most recent rendered user-message text.
    const sentText = await probe.eventually(async () => {
      const value = await probe.eval(`(() => {
        const messages = [...document.querySelectorAll('[data-message-role="user"]')];
        return messages.at(-1)?.innerText ?? "";
      })()`);
      return typeof value === "string" ? value : "";
    }, {
      within: 30_000,
      intervalMs: 100,
      label: "sent user message",
      until: (value) => value.includes(world.sendMarker),
    });
    expect(sentText).toContain(world.sendMarker);
    expect(sentText).not.toContain(draftA1);
    expect(sentText).not.toContain(draftB1);
    expect((await probe.composer()).draftText.trim()).toBe("");
    await user.screenshot();
  });
});
