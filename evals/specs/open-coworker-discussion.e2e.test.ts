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
        typing: Boolean(document.querySelector('[data-testid="coworker-typing"]')),
        chip: document.querySelector('[data-testid="coworker-tool-chip"]')?.textContent?.trim() ?? "",
        liveBubble: Boolean(document.querySelector('[data-testid="coworker-live-bubble"]')),
        phase: document.querySelector('[data-testid="coworker-working"]')?.getAttribute("data-phase") ?? (document.querySelector('[data-testid="live-row-slot"][data-open="true"] [data-live="true"]') ? "writing" : ""),
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
  // While working, the transcript reads like someone typing: a typing bubble while the coworker
  // thinks (no phrase), a chip in everyday words while a tool runs, and the words themselves in a
  // live bubble once they arrive; the coworker's personality never replaces the operational state.
  const liveShapes = beforeReply.filter((entry) => entry.working || entry.liveBubble);
  expect(liveShapes.length, `live shapes: ${JSON.stringify(beforeReply)}`).toBeGreaterThan(0);
  expect(liveShapes.some((entry) => entry.typing || entry.chip || entry.liveBubble), `something live was on screen: ${JSON.stringify(liveShapes)}`).toBe(true);
  for (const chip of new Set(liveShapes.map((entry) => String(entry.chip)).filter(Boolean))) {
    expect(chip).toMatch(/^(Using .+|Editing .+|Writing .+|Reading .+|Looking through .+|Running .+|Searching .+|Updating .+|Working with .+|Asking .+|Checking .+)$/);
  }
  expect(liveShapes.every((entry) => !entry.typing || String(entry.phase) === "thinking"), "the typing bubble means thinking").toBe(true);
  expect(liveShapes.every((entry) => !entry.chip || String(entry.phase) === "tool"), "a chip means a tool").toBe(true);
  expect(beforeReply.every((entry) => !entry.working || ["sending", "thinking", "tool", "writing", "retrying"].includes(String(entry.phase)))).toBe(true);
  // Once the turn has closed, the live row is gone, thinking folds to one quiet line, and tool work
  // to one receipt per reply, with no raw tool identifiers in either collapsed line.
  const folded = await waitFor(app, `(() => {
    const status = document.querySelector('[data-testid="coworker-thread-status"]');
    if (!(status instanceof HTMLElement) || status.dataset.state !== "idle" || status.textContent?.trim() !== "Ready") return false;
    return {
      thinking: [...document.querySelectorAll('[data-testid="coworker-thinking"] summary')].map((node) => node.textContent?.trim() ?? ""),
      receipts: [...document.querySelectorAll('[data-testid="coworker-work-summary"]')].map((node) => node.textContent?.trim() ?? ""),
      liveRows: document.querySelectorAll('[data-testid="coworker-working"]').length,
    };
  })()`, { timeoutMs: 180_000, label: "discussion settled after the first reply" });
  if (!isRecord(folded) || !Array.isArray(folded.thinking) || !Array.isArray(folded.receipts)) throw new Error("Folded transcript facts were unavailable.");
  expect(folded.liveRows).toBe(0);
  for (const line of folded.thinking) expect(String(line)).toMatch(/^Thought through/);
  for (const line of folded.receipts) expect(String(line)).not.toMatch(/[a-z]+_[a-z]+|Thinking…|Working$/);

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
  // Discussions never count as assignments. The header carries no Assignments control any more;
  // the composer's summary line names none, and Activity › Assignments has nothing handed over.
  const assignmentFacts = await evalIn(app, `(() => ({
    headerAssignmentsControl: [...document.querySelectorAll('[data-testid="conversation-header"] button')].some((button) => (button.textContent ?? "").startsWith("Assignments")),
    summaryParts: [...document.querySelectorAll('[data-testid^="summary-part-"]')].map((part) => part.textContent?.trim()),
    brandLine: (document.querySelector('[data-testid="coworker-composer"]')?.textContent ?? "").includes("Powered by"),
  }))()`);
  expect(assignmentFacts).toEqual({ headerAssignmentsControl: false, summaryParts: [], brandLine: false });
  await evalIn(app, `document.querySelector('[data-testid="context-rail-overview"]').click()`);
  await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="activity-row-assignments"]');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "the Assignments row of Activity" });
  await waitForText(app, "Nothing handed over yet", { timeoutMs: 30_000 });
  expect(await evalIn(app, `document.querySelector('[data-testid="assignment-list"]') === null`)).toBe(true);
  // The conversation stays where it was while the panel is open; Escape twice folds the panel again.
  expect(await evalIn(app, `(document.querySelector("main")?.innerText ?? "").includes("SECOND CHAT READY")`)).toBe(true);
  await evalIn(app, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-depth") === "0"`, { timeoutMs: 10_000, label: "back at the Activity root" });
  await evalIn(app, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed") === "true"`, { timeoutMs: 10_000, label: "panel folded" });

  evidence.recordAssertionEvidence(
    "A coworker's discussion waits for a matched reply and survives reload without becoming an assignment",
    `The first user message became visible, the UI exposed a real working interval with no Ready status before the matched assistant response, and native discussion ${discussionThreadId} persisted across reload and a second turn while nothing counted as an assignment: no Assignments control in the header, no summary line part, and an empty once list under Activity › Assignments.`,
    true,
  );

  // The coworker is introduced once, in the header. The thread row below names the
  // discussion itself (after its first message) and is where discussions are switched. A view
  // that was just reopened names it as soon as its first read of the thread lands.
  await waitFor(app, `document.querySelector('[data-testid="coworker-discussion-switcher"]')?.textContent?.trim() === ${json(firstPrompt)}`, { timeoutMs: 30_000, label: "the discussion named after its first message" });
  const headerShape = await evalIn(app, `(() => {
    // The coworker column: the identity header plus the thread area beneath it.
    const column = document.querySelector("main")?.parentElement;
    const avatarsOutsideMessages = [...(column?.querySelectorAll('[role="img"][aria-label="Editor avatar"]') ?? [])]
      .filter((avatar) => !avatar.closest('[data-message-role]')).length;
    return {
      avatarsOutsideMessages,
      mentionsDiscussionWith: (column?.innerText ?? "").includes("Discussion with Editor"),
      switcherLabel: document.querySelector('[data-testid="coworker-discussion-switcher"]')?.textContent?.trim() ?? "",
    };
  })()`);
  expect(headerShape).toMatchObject({
    avatarsOutsideMessages: 1,
    mentionsDiscussionWith: false,
    switcherLabel: firstPrompt,
  });

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
    `The main column introduced Editor once (one avatar outside message bubbles, no repeated "Discussion with Editor" heading) and titled the first discussion after its first message. New discussion opened native thread ${secondDiscussionId}; its message was accepted (status "${String(statusWhenLeaving)}" when leaving), the switcher listed both discussions with the open one checked, returning to ${discussionThreadId} showed that discussion alone, and coming back found the matched reply in ${secondDiscussionId}. discussions.json registered both ids and the composer's summary line still counted no assignment.`,
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
  // The failure is a message on Editor's side of the conversation, not a card across the column:
  // one headline, the exact model id in the detail, lettered ways out, the raw text folded away.
  const failureText = await waitFor(app, `(() => {
    const failure = document.querySelector('[data-testid="coworker-turn-failed"]');
    return failure?.textContent ?? false;
  })()`, { timeoutMs: 120_000, label: "actionable failed discussion turn" });
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-turn-headline"]')?.textContent?.trim()`)).toBe("Editor's AI model is not available.");
  expect(failureText).toContain("missing-provider/missing-model");
  expect(failureText).toContain("Choose AI model");
  expect(failureText).toContain("Continue with OpenWork");
  expect(String(failureText)).not.toMatch(/engine|APIError|stack/i);
  const failureLayout = await evalIn(app, `(() => {
    const failure = document.querySelector('[data-testid="coworker-turn-failed"]');
    const headline = failure?.querySelector('[data-testid="coworker-turn-headline"]');
    const technical = failure?.querySelector('[data-testid="coworker-turn-technical"]');
    const choices = [...(failure?.querySelectorAll('[data-testid="coworker-turn-choice"]') ?? [])];
    return {
      headlineFirst: Boolean(headline) && failure?.firstElementChild?.contains(headline) === true,
      technicalOpen: technical instanceof HTMLDetailsElement ? technical.open : null,
      loadingIndicator: Boolean(document.querySelector('[data-testid="coworker-working"]')),
      roseCard: /rose/.test(failure?.className ?? "") || Boolean(document.querySelector('[data-testid="coworker-turn-timeout"]')),
      widthRatio: failure && failure.parentElement ? failure.getBoundingClientRect().width / failure.parentElement.getBoundingClientRect().width : null,
      choices: choices.map((choice) => ({ letter: choice.getAttribute("data-letter"), choice: choice.getAttribute("data-choice") })),
      outcome: document.querySelector('[data-testid="coworker-thread-status"]')?.getAttribute("data-outcome"),
    };
  })()`);
  expect(failureLayout).toMatchObject({ headlineFirst: true, loadingIndicator: false, roseCard: false, outcome: "failed" });
  if (!isRecord(failureLayout) || !Array.isArray(failureLayout.choices)) throw new Error("Failure layout facts were unavailable.");
  expect(failureLayout.choices.length).toBeLessThanOrEqual(3);
  expect(failureLayout.choices.map((choice) => (isRecord(choice) ? choice.letter : null))).toEqual(["A", "B", "C"].slice(0, failureLayout.choices.length));
  expect(failureLayout.choices.map((choice) => (isRecord(choice) ? choice.choice : null))).toEqual(expect.arrayContaining(["choose-model", "continue-with-openwork"]));
  expect(Number(failureLayout.widthRatio)).toBeLessThanOrEqual(0.8);
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
    "The failed turn kept the user's prompt visible and answered with one coworker-side message at the bubble's width — a human headline naming Editor's AI model first, the exact unavailable model id in the detail, at most three lettered choices including Choose AI model and Continue with OpenWork, no rose card, no lingering working indicator — while the thread header, the coworker header, and the rail said the same thing; the B choice opened Coworker settings at the AI model section and the discussion id was preserved.",
    true,
  );
});
