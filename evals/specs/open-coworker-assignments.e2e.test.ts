import { EVAL_COWORKER_MODEL, clickButton, coworker, evalIn, fill, needs, test, waitFor, waitForText } from "@openwork/testkit";
import { expect } from "vitest";

/**
 * Natural chat never becomes assigned work by itself. This journey chats
 * first, then creates one explicit assignment from the discussion and proves
 * it is a separate native session that carries only the visible prose, while
 * the standing discussion stays where it was and out of the assignment count.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker creates an explicit assignment from a discussion as a separate native session"
  : "Open Coworker assignment journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const CHAT_PROMPT = "Reply with exactly CHAT ONE READY.";
const CHAT_REPLY = "CHAT ONE READY";
const OUTCOME = "Reply with exactly ASSIGNMENT ONE DONE. Do not use tools.";
const ASSIGNMENT_REPLY = "ASSIGNMENT ONE DONE";

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(app, `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

/** Native session list and one session's visible user/assistant texts, read through the embedded server's engine proxy. */
async function readEngineSessions(app: Awaited<ReturnType<typeof coworker>>, workspaceId: string): Promise<Array<{ id: string; title: string }>> {
  const value = await evalIn(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const response = await fetch(runtime.serverUrl + "/workspace/" + encodeURIComponent(${json(workspaceId)}) + "/opencode/session", {
      headers: { Authorization: "Bearer " + runtime.ownerToken },
    });
    if (!response.ok) throw new Error("session list failed: " + response.status);
    const sessions = await response.json();
    return sessions.filter((session) => !session.parentID).map((session) => ({ id: session.id, title: session.title ?? "" }));
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.title === "string")) {
    throw new Error(`Unexpected native session list: ${JSON.stringify(value)}`);
  }
  return value.map((entry) => ({ id: String(entry.id), title: String(entry.title) }));
}

async function readSessionTexts(app: Awaited<ReturnType<typeof coworker>>, workspaceId: string, sessionId: string): Promise<Array<{ role: string; text: string }>> {
  const value = await evalIn(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const response = await fetch(runtime.serverUrl + "/workspace/" + encodeURIComponent(${json(workspaceId)}) + "/opencode/session/" + encodeURIComponent(${json(sessionId)}) + "/message", {
      headers: { Authorization: "Bearer " + runtime.ownerToken },
    });
    if (!response.ok) throw new Error("message list failed: " + response.status);
    const messages = await response.json();
    return messages.map((message) => ({
      role: message.info.role,
      text: message.parts.filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text ?? "").join(""),
    }));
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) && typeof entry.role === "string" && typeof entry.text === "string")) {
    throw new Error(`Unexpected native message list: ${JSON.stringify(value)}`);
  }
  return value.map((entry) => ({ role: String(entry.role), text: String(entry.text) }));
}

async function waitForAssistantText(app: Awaited<ReturnType<typeof coworker>>, expected: string): Promise<void> {
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')]
    .some((message) => (message.textContent ?? "").includes(${json(expected)}))`, {
    timeoutMs: 300_000,
    label: `assistant response ${json(expected)}`,
  });
}

test.skipIf(!enabled)(title, { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using app = await coworker({ name: "assignments" });

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const created = resultRecord(await invokeCoworker(app, "coworkers.create", {
    name: "Editor",
    role: "Writing partner",
    mission: "Help shape clear product writing.",
    avatarColor: "mint",
    avatarGlasses: "square",
  }));
  const workspaceId = String(created.workspaceId);
  expect(workspaceId).not.toBe("");
  await invokeCoworker(app, "coworkers.update", { slug: "editor", patch: { model: EVAL_COWORKER_MODEL, modelVariant: "" } });
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Editor")`, {
    timeoutMs: 120_000,
    label: "Editor discussion view",
  });

  // A person waits for the coworker to read Ready before asking anything of it; so does the journey.
  await waitFor(app, `(() => {
    const status = document.querySelector('[data-testid="coworker-top-status"]');
    if (!(status instanceof HTMLElement)) return false;
    return status.textContent?.trim() === "Ready";
  })()`, { timeoutMs: 240_000, label: "coworker AI ready" });

  // --- Chat first. Nothing here is an assignment.
  await fill(app, 'textarea[aria-label="Message Editor"]', CHAT_PROMPT);
  await clickButton(app, "Send");
  await waitForAssistantText(app, CHAT_REPLY);
  // The reply text can land before the turn closes; wait for the discussion to settle so the
  // composer's assignment control is enabled again.
  await waitFor(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.dataset.state === "idle"`, {
    timeoutMs: 120_000,
    label: "discussion turn settled",
  });
  const editor = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  const discussionId = String(editor.conversationThreadId);
  expect(discussionId).toMatch(/^ses_/);
  // Nothing counts as an assignment yet: the composer's summary line has no assignments part.
  const assignmentsBefore = await evalIn(app, `[...document.querySelectorAll('[data-testid^="summary-part-"]')].map((part) => part.textContent?.trim())`);
  expect(assignmentsBefore).toEqual([]);
  const sessionsBefore = await readEngineSessions(app, workspaceId);
  expect(sessionsBefore.map((session) => session.id)).toEqual([discussionId]);

  evidence.recordAssertionEvidence(
    "A natural discussion turn does not create an assignment",
    `After one chat exchange the coworker owned exactly one native session (${discussionId}, the discussion) and the composer's summary line counted no assignment.`,
    true,
  );

  // --- Create one explicit assignment from the discussion composer. The composer stays busy
  // until the coworker has finished its turn, which can outlast the visible reply text.
  await clickButton(app, "Create assignment", { timeoutMs: 180_000 });
  await waitForText(app, "Something Editor should own, separate from this chat", { timeoutMs: 30_000 });
  await fill(app, 'textarea[aria-label="Assignment outcome"]', OUTCOME);
  await clickButton(app, "Create assignment");

  // One line under eighty characters: the outcome itself is the assignment's title.
  const expectedTitle = OUTCOME;
  await waitForText(app, expectedTitle, { timeoutMs: 60_000 });
  // The conversation column is the surface under test: the one header now carries the
  // assignment's title and badge. The rail and Activity view may truthfully name the
  // discussion while its session is still busy.
  await waitFor(app, `(() => {
    const badge = [...document.querySelectorAll('[data-testid="conversation-header"] span, main span')].some((span) => (span.textContent ?? "").trim() === "Assignment");
    return badge && !document.querySelector('[data-testid="coworker-discussion-view"]');
  })()`, {
    timeoutMs: 30_000,
    label: "assignment thread view with its badge replaces the discussion view",
  });
  await waitForAssistantText(app, ASSIGNMENT_REPLY);

  // What the person sees is the brief, not the scaffolding the model needs: the outcome up front,
  // the carried discussion behind one small disclosure, no headings or instructions in view.
  const briefView = await evalIn(app, `(() => {
    const brief = document.querySelector('[data-message-role="user"][data-assignment-brief="true"]');
    if (!(brief instanceof HTMLElement)) return null;
    const context = brief.querySelector('[data-testid="coworker-assignment-context"]');
    return {
      outcome: brief.querySelector('[data-testid="coworker-assignment-outcome"]')?.textContent?.trim() ?? "",
      visibleText: brief.innerText,
      contextSummary: context?.querySelector("summary span:not([aria-hidden])")?.textContent?.trim() ?? "",
      contextOpen: context instanceof HTMLDetailsElement ? context.open : null,
      plainUserBubbles: document.querySelectorAll('[data-message-role="user"]:not([data-assignment-brief])').length,
    };
  })()`);
  expect(briefView).toMatchObject({ outcome: OUTCOME, contextSummary: "From your discussion · 2 messages", contextOpen: false, plainUserBubbles: 0 });
  if (!isRecord(briefView) || typeof briefView.visibleText !== "string") throw new Error("Assignment brief facts were unavailable.");
  expect(briefView.visibleText.toLowerCase()).toContain("assignment for editor");
  expect(briefView.visibleText).not.toMatch(/## |explicit assignment|Own this outcome|source of truth|Coworker:/);

  const sessionsAfter = await readEngineSessions(app, workspaceId);
  expect(sessionsAfter).toHaveLength(2);
  const assignment = sessionsAfter.find((session) => session.id !== discussionId);
  if (!assignment) throw new Error(`No assignment session beside the discussion: ${JSON.stringify(sessionsAfter)}`);
  expect(assignment.title).toBe(expectedTitle);

  // The discussion itself is untouched: same id, same two messages.
  const discussionTexts = await readSessionTexts(app, workspaceId, discussionId);
  expect(discussionTexts.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(discussionTexts[0]?.text).toBe(CHAT_PROMPT);
  expect(discussionTexts[1]?.text).toContain(CHAT_REPLY);

  // The assignment's first turn is the outcome plus the visible prose of that discussion, whole and in
  // order, and nothing else the thread held — no reasoning, no tool payloads.
  const assignmentTexts = await readSessionTexts(app, workspaceId, assignment.id);
  const firstUserTurn = assignmentTexts.find((message) => message.role === "user");
  const [discussionAsk, discussionReply] = discussionTexts;
  if (!discussionAsk || !discussionReply) throw new Error(`The discussion lost a message: ${JSON.stringify(discussionTexts)}`);
  expect(firstUserTurn?.text).toContain(`## Outcome\n\n${OUTCOME}`);
  expect(firstUserTurn?.text).toContain(`## Relevant discussion\n\nYou: ${discussionAsk.text.trim()}\n\nCoworker: ${discussionReply.text.trim()}`);
  expect(firstUserTurn?.text).toContain(`You: ${CHAT_PROMPT}`);
  expect(firstUserTurn?.text).toContain(`Coworker: ${CHAT_REPLY}`);
  for (const forbidden of ["reasoning", "toolCalls", "partId", "openworkMcpApp", "metadata"]) {
    expect(firstUserTurn?.text).not.toContain(forbidden);
  }
  expect(String(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId)).toBe(discussionId);

  evidence.recordAssertionEvidence(
    "Create assignment yields a separate native session carrying only visible discussion prose",
    `In the assignment view the opening message read as a brief — "Assignment for Editor", the outcome, and a closed "From your discussion · 2 messages" disclosure — with no headings, instructions, or Coworker: lines in view. The explicit assignment became native session ${assignment.id} titled "${expectedTitle}", distinct from discussion ${discussionId}; its first turn equalled the bounded prompt built from the two visible messages and contained no reasoning or tool payload fields, and the discussion still held exactly its original two messages.`,
    true,
  );

  // --- Back to the discussion: the summary line counts one, Activity › Assignments names it, the chat is unchanged.
  await clickButton(app, "Back");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]'))`, { timeoutMs: 60_000, label: "back in the discussion view" });
  // The discussion is titled after its first message; that title belongs to the thread row, not the
  // assignment list. Wait for the row itself: the sidebar can show the same words before the
  // transcript has loaded back into the view.
  await waitFor(app, `(document.querySelector('[data-testid="coworker-discussion-switcher"]')?.textContent ?? "").includes(${JSON.stringify(CHAT_PROMPT)})`, {
    timeoutMs: 60_000,
    label: "discussion row titled after its first message",
  });
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(${JSON.stringify(CHAT_REPLY)}))`, {
    timeoutMs: 30_000,
    label: "chat reply back in the discussion view",
  });
  // The quiet line under the composer counts the one assignment; it is the way into Activity › Assignments.
  await waitFor(app, `document.querySelector('[data-testid="summary-part-assignments"]')?.textContent?.trim() === "1 assignment"`, {
    timeoutMs: 30_000,
    label: "summary line: 1 assignment",
  });
  const composerLine = await evalIn(app, `(() => {
    const composer = document.querySelector('[data-testid="coworker-composer"]');
    return {
      line: composer?.querySelector('[data-testid="coworker-summary-line"]')?.textContent?.trim() ?? "",
      brandLine: (composer?.textContent ?? "").includes("Powered by"),
      headerAssignmentsControl: [...document.querySelectorAll('[data-testid="conversation-header"] button')].some((button) => (button.textContent ?? "").startsWith("Assignments")),
    };
  })()`);
  expect(composerLine).toEqual({ line: "1 assignment", brandLine: false, headerAssignmentsControl: false });
  await evalIn(app, `document.querySelector('[data-testid="summary-part-assignments"]').click(); true`);
  const panelAssignments = await waitFor(app, `(() => {
    const section = document.querySelector('[data-testid="coworker-assignments"]');
    const rows = [...document.querySelectorAll('[data-testid="assignment-row"]')];
    if (!(section instanceof HTMLElement) || rows.length === 0) return false;
    return {
      route: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") ?? "",
      crumbs: [...document.querySelectorAll('[data-testid="panel-crumb"]')].map((crumb) => crumb.textContent?.trim()),
      rows: rows.map((row) => row.innerText.replace(/\\s+/g, " ").trim()),
      scheduledEmpty: Boolean(section.querySelector('[data-testid="responsibilities-empty"]')),
      cards: section.querySelectorAll(".rounded-2xl").length,
      mentionsDiscussion: (section.innerText ?? "").includes(${JSON.stringify(CHAT_PROMPT)}),
    };
  })()`, { timeoutMs: 30_000, label: "the assignment in Activity › Assignments" });
  expect(panelAssignments).toMatchObject({ route: "overview/assignments", crumbs: ["Activity", "Assignments"], scheduledEmpty: true, cards: 0, mentionsDiscussion: false });
  if (!isRecord(panelAssignments) || !Array.isArray(panelAssignments.rows)) throw new Error("Panel assignment rows were unavailable.");
  expect(panelAssignments.rows).toHaveLength(1);
  expect(String(panelAssignments.rows[0])).toContain(expectedTitle);
  expect(String(panelAssignments.rows[0])).toMatch(/(Done .+ ago|Working on it)/);
  // The Activity root's row says the same number.
  await evalIn(app, `document.querySelector('[data-testid="panel-back"]').click(); true`);
  await waitFor(app, `(document.querySelector('[data-testid="activity-row-assignments"]')?.textContent ?? "").includes("1 assignment")`, { timeoutMs: 30_000, label: "Activity row: 1 assignment" });
  await evalIn(app, `document.querySelector('[data-testid="activity-row-assignments"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="assignment-row"]'))`, { timeoutMs: 30_000, label: "the Assignments level again" });
  await evalIn(app, `document.querySelector('[data-testid="assignment-row"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-assignment-view"]'))`, { timeoutMs: 30_000, label: "the assignment opened from the panel" });
  await evalIn(app, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);

  evidence.recordAssertionEvidence(
    "The standing discussion stays out of the assignment count and list, and the panel lists the assignment once",
    `Back in the discussion the composer's summary line read "1 assignment" (no Assignments control in the header, no brand line); it opened Activity › Assignments, where "${expectedTitle}" was the single flat row (Done), beside an empty schedule and without the discussion; the Activity root's row read 1 assignment too, and the row opened the assignment in the main column.`,
    true,
  );
});
