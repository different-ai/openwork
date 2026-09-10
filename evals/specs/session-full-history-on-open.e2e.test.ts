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

test("opening a long conversation shows the latest first and preserves access to its entire history", async ({ user, agent, probe, step, world }) => {
  const messagesPath = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode/session/${encodeURIComponent(world.session.sessionId)}/message`;
  const surface = `[data-session-surface-id="${world.session.sessionId}"]`;
  const latestVisible = async () => {
    const { elements } = await probe.dom(`${surface} [data-thread-scroll], ${surface} [data-message-id]`);
    const viewport = elements[0];
    const latest = elements.slice(1).find((element) => element.text.includes(longHistoryLast));
    return Boolean(viewport && latest && latest.rect.height > 0 && latest.rect.bottom > viewport.rect.top && latest.rect.top < viewport.rect.bottom);
  };

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
    // Read-only geometry: `user.see` may scroll a target into view and would
    // conceal a regression where opening incorrectly lands at the first row.
    await probe.eventually(latestVisible, { within: 60_000, label: "latest message visible without scrolling", until: Boolean });
    const rendered = await probe.eventually(async () => renderedCount(await agent.run("session.read_transcript", { count: 1 })), {
      within: 60_000,
      label: "rendered transcript length",
      until: (count) => count >= longHistoryCount,
    });
    expect(rendered).toBe(longHistoryCount);
    expect(rendered).not.toBe(oldPageSize);
    await probe.eventually(async () => {
      expect(await latestVisible()).toBe(true);
      return (await probe.dom(`${surface} [data-thread-history-complete="true"]`)).elements.length;
    }, { within: 30_000, label: "background history mounting preserves the latest viewport", until: (count) => count === 1 });
    expect((await probe.dom(`${surface} [data-thread-loading]`)).elements).toHaveLength(0);
  });

  await step("the first message is reachable at the top of the transcript", async () => {
    await agent.run("session.scroll_top");
    await user.see({ text: longHistoryFirst }, { timeoutMs: 30_000 });
    await user.looks([
      `The conversation transcript visibly starts with a user message reading "${longHistoryFirst}"`,
      "The transcript shows no loading indicator, error card, or empty-conversation placeholder",
    ]);
  });

  // Baseline branch coverage after full loading, not the delayed-preview race.
  await step("after full loading, branching at the first message excludes later history and leaves the source unchanged", async () => {
    await user.click({ role: "button", label: "Branch in new chat", nth: 0 });
    // count limits returned messages; messageCount is the entire rendered transcript.
    await probe.eventually(async () => renderedCount(await agent.run("session.read_transcript", { count: 1 })), {
      within: 30_000,
      label: "branch contains only the clicked message",
      until: (count) => count === 1,
    });
    await user.see({ text: longHistoryFirst });
    await user.notSee({ text: longHistoryLast });
    const source = await probe.desktopApi(messagesPath);
    expect(source.status).toBe(200);
    expect(messageTexts(source.body)).toHaveLength(longHistoryCount);
  });
});
