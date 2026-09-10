import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  longHistory,
  longHistoryCount,
  longHistoryFirst,
  longHistoryLast,
  longHistoryTitle,
} from "../worlds/chat.ts";

const test = spec.world(longHistory, { timeout: 600_000 });

/** The page size the transcript read used to request; OpenCode returns the newest n. */
const oldPageSize = 140;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageTexts(body: unknown): string[] {
  if (!Array.isArray(body)) throw new Error(`Engine did not return a message list: ${JSON.stringify(body).slice(0, 200)}`);
  return body.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message.parts)) return [];
    return message.parts.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []));
  });
}

function renderedCount(value: unknown): number {
  if (!isRecord(value) || value.ok !== true || typeof value.messageCount !== "number") {
    throw new Error(`session.read_transcript did not report a rendered count: ${JSON.stringify(value)}`);
  }
  return value.messageCount;
}

test("opening a long conversation shows it from its first message", async ({ user, agent, probe, step, world }) => {
  const messagesPath = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode/session/${encodeURIComponent(world.session.sessionId)}/message`;

  await step("the engine stores more messages than one newest-first page holds", async () => {
    const stored = await probe.desktopApi(messagesPath);
    expect(stored.status).toBe(200);
    const texts = messageTexts(stored.body);
    expect(texts).toHaveLength(longHistoryCount);
    expect(texts[0]).toBe(longHistoryFirst);
    expect(texts.at(-1)).toBe(longHistoryLast);

    // Witness for the trap: a `limit` page is the NEWEST n messages, so the
    // first message is outside it. The spec would be vacuous otherwise.
    const page = await probe.desktopApi(`${messagesPath}?limit=${oldPageSize}`);
    expect(page.status).toBe(200);
    const pageTexts = messageTexts(page.body);
    expect(pageTexts).toHaveLength(oldPageSize);
    expect(pageTexts).not.toContain(longHistoryFirst);
    expect(pageTexts.at(-1)).toBe(longHistoryLast);
  });

  await step("a cold start lands on the other session with no transcript cached for the long one", async () => {
    await user.reload();
    await user.see({ role: "button", label: new RegExp(`^${longHistoryTitle}`) }, { timeoutMs: 60_000 });
    await user.notSee({ text: longHistoryLast });
    await user.notSee({ text: longHistoryFirst });
  });

  await step("clicking the long conversation renders every stored message", async () => {
    await user.click({ role: "button", label: new RegExp(`^${longHistoryTitle}`) });
    await user.see({ text: longHistoryLast }, { timeoutMs: 60_000 });
    const rendered = await probe.eventually(async () => renderedCount(await agent.run("session.read_transcript", { count: 1 })), {
      within: 60_000,
      label: "rendered transcript length",
      until: (count) => count >= longHistoryCount,
    });
    expect(rendered).toBe(longHistoryCount);
    expect(rendered).not.toBe(oldPageSize);
  });

  await step("the first message is reachable at the top of the transcript", async () => {
    await agent.run("session.scroll_top");
    await user.see({ text: longHistoryFirst }, { timeoutMs: 30_000 });
    await user.looks([
      `The conversation transcript visibly starts with a user message reading "${longHistoryFirst}"`,
      "The transcript shows no loading indicator, error card, or empty-conversation placeholder",
    ]);
  });
});
