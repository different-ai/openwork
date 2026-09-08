import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVAL_COWORKER_MODEL, clickButton, coworker, evalIn, fill, needs, test, waitFor, waitForText } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker keeps one native discussion honest across replies, reloads, and model failure"
  : "Open Coworker discussion journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(
    app,
    `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`,
    { awaitPromise: true, timeoutMs: 120_000 },
  );
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

/** The discussion surface for Editor: the header names the coworker once; the thread row below carries the discussion. */
async function waitForDiscussionView(app: Awaited<ReturnType<typeof coworker>>, timeoutMs: number): Promise<void> {
  await waitFor(app, `(() => {
    const view = document.querySelector('[data-testid="coworker-discussion-view"]');
    const named = [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Editor");
    return Boolean(view) && named;
  })()`, { timeoutMs, label: "Editor discussion view" });
}

async function openDiscussionMenu(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-switcher"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-menu"]'))`, { timeoutMs: 10_000, label: "discussion menu" });
}

async function reload(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await evalIn(app, "location.reload(); true");
  await waitForDiscussionView(app, 120_000);
  await waitFor(app, `Boolean(document.querySelector('textarea[aria-label="Message Editor"]'))`, {
    timeoutMs: 60_000,
    label: "Editor discussion composer",
  });
}

async function beginStatusTrace(app: Awaited<ReturnType<typeof coworker>>, prompt: string): Promise<void> {
  await evalIn(app, `(() => {
    window.__COWORKER_CHAT_TRACE__?.observer?.disconnect?.();
    const trace = [];
    const record = () => {
      const userMessages = [...document.querySelectorAll('[data-message-role="user"]')];
      const assistantMessages = [...document.querySelectorAll('[data-message-role="assistant"]')];
      trace.push({
        userVisible: userMessages.some((message) => (message.textContent ?? "").includes(${json(prompt)})),
        assistantReady: assistantMessages.some((message) => (message.textContent ?? "").includes("COWORKER CHAT READY")),
        threadStatus: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "",
        topStatus: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
        working: Boolean(document.querySelector('[data-testid="coworker-working"]')),
      });
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__COWORKER_CHAT_TRACE__ = { trace, observer };
    record();
    return true;
  })()`);
}

async function sendDiscussionMessage(
  app: Awaited<ReturnType<typeof coworker>>,
  prompt: string,
  expected: string,
): Promise<unknown> {
  await fill(app, 'textarea[aria-label="Message Editor"]', prompt);
  await clickButton(app, "Send");
  await waitFor(app, `(() => {
    const message = [...document.querySelectorAll('[data-message-role="user"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(prompt)}));
    return message?.textContent ?? false;
  })()`, { timeoutMs: 30_000, label: `visible user message ${json(prompt)}` });
  return waitFor(app, `(() => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(expected)}));
    return message?.textContent ?? false;
  })()`, { timeoutMs: 300_000, label: `assistant response ${json(expected)}` });
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  // Keep the profile outside this repository: OpenCode walks parent directories for project
  // configuration, and a profile under evals/results would inherit this checkout's own plugins and
  // MCPs — a slow first start that has nothing to do with a person's first launch.
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-discussion-profile-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  await using app = await coworker({ name: "persistent-discussion", profileDir });

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const created = resultRecord(await invokeCoworker(app, "coworkers.create", {
    name: "Editor",
    role: "Writing partner",
    mission: "Help shape clear product writing.",
    avatarColor: "blue",
    avatarGlasses: "round",
  }));
  expect(created.workspaceId).toEqual(expect.any(String));
  expect(created.workspaceId).not.toBe("");
  await invokeCoworker(app, "coworkers.update", {
    slug: "editor",
    patch: { model: EVAL_COWORKER_MODEL, modelVariant: "" },
  });
  await reload(app);
  // The first coworker's AI service restarts to pick up the new workspace; a person waits for
  // "Ready" in the header before typing, so the journey does too.
  await waitFor(app, `(() => {
    const status = document.querySelector('[data-testid="coworker-top-status"]');
    if (!(status instanceof HTMLElement)) return false;
    return status.textContent?.trim() === "Ready";
  })()`, { timeoutMs: 240_000, label: "coworker AI ready before the first discussion" });

  const firstPrompt = "Reply with exactly COWORKER CHAT READY.";
  await beginStatusTrace(app, firstPrompt);
  const firstReply = await sendDiscussionMessage(app, firstPrompt, "COWORKER CHAT READY");
  expect(firstReply).toContain("COWORKER CHAT READY");

  const traceValue = await evalIn(app, `(() => {
    window.__COWORKER_CHAT_TRACE__?.observer?.disconnect?.();
    return window.__COWORKER_CHAT_TRACE__?.trace ?? [];
  })()`);
  if (!Array.isArray(traceValue) || !traceValue.every(isRecord)) {
    throw new Error("The discussion status trace was unavailable.");
  }
  const afterUser = traceValue.filter((entry) => entry.userVisible === true);
  const replyIndex = afterUser.findIndex((entry) => entry.assistantReady === true);
  expect(replyIndex).toBeGreaterThan(0);
  const beforeReply = afterUser.slice(0, replyIndex);
  expect(beforeReply.some((entry) => entry.working === true)).toBe(true);
  expect(beforeReply.every((entry) => entry.threadStatus !== "Ready")).toBe(true);
  expect(
    beforeReply.every((entry) => entry.topStatus !== "Ready"),
    `status trace before the matched reply: ${JSON.stringify(beforeReply)}`,
  ).toBe(true);
  await waitFor(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.dataset.state === "idle" && !document.querySelector('[data-testid="coworker-working"]')`, { timeoutMs: 180_000, label: "discussion settled after the first reply" });

  const storedAfterFirst = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  expect(storedAfterFirst.conversationThreadId).toEqual(expect.stringMatching(/^ses_/));
  const discussionThreadId = storedAfterFirst.conversationThreadId;

  await reload(app);
  await waitForText(app, "COWORKER CHAT READY", { timeoutMs: 60_000 });
  const storedAfterReload = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  expect(storedAfterReload.conversationThreadId).toBe(discussionThreadId);

  const secondReply = await sendDiscussionMessage(
    app,
    "Reply with exactly SECOND CHAT READY.",
    "SECOND CHAT READY",
  );
  expect(secondReply).toContain("SECOND CHAT READY");
  const storedAfterSecond = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  expect(storedAfterSecond.conversationThreadId).toBe(discussionThreadId);

  // The reply's text lands a moment before its turn closes; let the live row go before reading the surface.
  await waitFor(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() === "Ready" && document.querySelectorAll('[data-testid="coworker-working"]').length === 0`, {
    timeoutMs: 120_000,
    label: "second turn settled",
  });
  evidence.recordAssertionEvidence(
    "A coworker's discussion waits for a matched reply and preserves its native thread across reload",
    `The first user message became visible with a working interval and no Ready status before the matched reply. Native discussion ${discussionThreadId} persisted across reload and a second turn.`,
    true,
  );

  // A second discussion runs beside the first: start it, send, leave while the reply is
  // still coming, return to the first, then come back to find the reply waiting.
  await openDiscussionMenu(app);
  await waitFor(app, `(() => {
    const item = document.querySelector('[data-testid="coworker-new-discussion"]');
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "New discussion menu item" });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-empty"]'))`, { timeoutMs: 30_000, label: "fresh discussion" });
  const storedAfterNew = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  const secondDiscussionId = String(storedAfterNew.conversationThreadId);
  expect(secondDiscussionId).toEqual(expect.stringMatching(/^ses_/));
  expect(secondDiscussionId).not.toBe(discussionThreadId);
  await waitFor(app, `(document.querySelector('[data-testid="coworker-discussion-switcher"]')?.textContent ?? "").includes("New discussion")`, {
    timeoutMs: 30_000,
    label: "fresh discussion labelled New discussion",
  });

  const parallelPrompt = "Reply with exactly PARALLEL CHAT READY.";
  await fill(app, 'textarea[aria-label="Message Editor"]', parallelPrompt);
  await clickButton(app, "Send");
  const statusWhenLeaving = await waitFor(app, `(() => {
    const visible = [...document.querySelectorAll('[data-message-role="user"]')]
      .some((candidate) => (candidate.textContent ?? "").includes(${json(parallelPrompt)}));
    const status = document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "";
    return visible && status !== "Sending" ? status : false;
  })()`, { timeoutMs: 60_000, label: "second discussion accepted its message" });

  await openDiscussionMenu(app);
  const menuBeforeReturn = await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-discussion-menu"] [role="menuitemradio"]')]
    .map((item) => ({ id: item.getAttribute("data-thread-id"), checked: item.getAttribute("aria-checked"), text: item.textContent?.trim() ?? "" }))`);
  expect(menuBeforeReturn).toHaveLength(2);
  expect(menuBeforeReturn).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: discussionThreadId, checked: "false", text: expect.stringContaining(firstPrompt) }),
    expect.objectContaining({ id: secondDiscussionId, checked: "true" }),
  ]));
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-menu"] [data-thread-id=${json(discussionThreadId)}]').click(); true`);
  await waitForText(app, "SECOND CHAT READY", { timeoutMs: 30_000 });
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId).toBe(discussionThreadId);
  // The thread area shows only the first discussion; the sidebar may truthfully report the other one still working.
  expect(await evalIn(app, `(document.querySelector("main")?.innerText ?? "").includes(${json(parallelPrompt)})`)).toBe(false);

  await openDiscussionMenu(app);
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-menu"] [data-thread-id=${json(secondDiscussionId)}]').click(); true`);
  const parallelReply = await waitFor(app, `(() => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes("PARALLEL CHAT READY"));
    return message?.textContent ?? false;
  })()`, { timeoutMs: 300_000, label: "reply that continued in the second discussion" });
  expect(parallelReply).toContain("PARALLEL CHAT READY");
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-switcher"]')?.textContent?.trim()`)).toContain(parallelPrompt);
  expect(await evalIn(app, `(document.querySelector("main")?.innerText ?? "").includes("SECOND CHAT READY")`)).toBe(false);

  // Both discussions are registered beside the coworker record, and neither counts as an assignment.
  const registry = resultRecord(await invokeCoworker(app, "coworkers.files.read", { slug: "editor", path: "discussions.json" }));
  const registered = JSON.parse(String(registry.content)) as { threadIds?: string[] };
  expect(registered.threadIds).toEqual(expect.arrayContaining([discussionThreadId, secondDiscussionId]));
  expect(await evalIn(app, `[...document.querySelectorAll('[data-testid^="summary-part-"]')].map((part) => part.getAttribute("data-testid"))`)).toEqual([]);

  evidence.recordAssertionEvidence(
    "A coworker holds parallel discussions that can be left, revisited, and resumed",
    `New discussion opened native thread ${secondDiscussionId}; its message was accepted (status "${String(statusWhenLeaving)}" when leaving). Returning to ${discussionThreadId} showed that discussion alone; coming back found the matched reply in ${secondDiscussionId} without the first discussion's reply. discussions.json registered both ids and the summary counted no assignment.`,
    true,
  );

  await invokeCoworker(app, "coworkers.update", {
    slug: "editor",
    patch: { model: "missing-provider/missing-model", modelVariant: "" },
  });
  await reload(app);
  const failurePrompt = "Reply with exactly THIS MUST FAIL.";
  await fill(app, 'textarea[aria-label="Message Editor"]', failurePrompt);
  await clickButton(app, "Send");
  // A missing saved model fails visibly without replacing the discussion.
  const failureText = await waitFor(app, `(() => {
    const failure = document.querySelector('[data-testid="coworker-turn-failed"]');
    if (!failure) return false;
    const technical = failure.querySelector('[data-testid="coworker-turn-technical"]');
    return (failure.textContent ?? "").replace(technical?.textContent ?? "", "");
  })()`, { timeoutMs: 120_000, label: "actionable failed discussion turn" });
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-turn-headline"]')?.textContent?.trim()`)).toBe("Editor's AI model is not available.");
  expect(failureText).toContain("missing-provider/missing-model");
  expect(failureText).toContain("Choose AI model");
  expect(failureText).toContain("Continue with OpenWork");
  expect(String(failureText)).not.toMatch(/engine|APIError|stack/i);
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim()`)).toBe("Reply failed");
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim()`)).toBe("Reply failed");
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim()`)).toBe("Editor's AI model is not available.");
  expect(await evalIn(app, `(() => [...document.querySelectorAll('[data-message-role="user"]')]
    .some((message) => (message.textContent ?? "").includes(${json(failurePrompt)})))()`)).toBe(true);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId).toBe(secondDiscussionId);
  await evalIn(app, `document.querySelector('[data-testid="coworker-turn-choice"][data-choice="choose-model"]').click(); true`);
  await waitForText(app, "Coworker settings", { timeoutMs: 30_000 });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-model-settings"]'))`, { timeoutMs: 30_000, label: "AI model section" });
  await waitForText(app, "This saved model is not currently available from a connected provider.", { timeoutMs: 30_000 });

  evidence.recordAssertionEvidence(
    "An invalid coworker model becomes a plain, actionable message in the conversation instead of a silent Ready thread",
    "The failed turn kept the user's prompt and native discussion id, named the unavailable model, and reported failure rather than Ready. Choose AI model opened Coworker settings at the unavailable saved model.",
    true,
  );
});
