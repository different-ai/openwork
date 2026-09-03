import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { coworker, needs, test } from "@openwork/testkit";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker answers in a few sentences and keeps the depth in a document beside the conversation"
  : "Open Coworker documents journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const SLUG = "planner";
const NAME = "Planner";

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type App = Awaited<ReturnType<typeof coworker>>;

async function invokeCoworker(app: App, command: string, payload: unknown): Promise<unknown> {
  return evalIn(app, `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function resultList(response: unknown): Record<string, unknown>[] {
  if (!isRecord(response) || response.ok !== true || !Array.isArray(response.result) || !response.result.every(isRecord)) {
    throw new Error(`Open Coworker bridge returned an unexpected list: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function waitForDiscussionView(app: App, timeoutMs: number): Promise<void> {
  await waitFor(app, `(() => {
    const view = document.querySelector('[data-testid="coworker-discussion-view"]');
    const named = [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === ${json(NAME)});
    return Boolean(view) && named;
  })()`, { timeoutMs, label: `${NAME} discussion view` });
}

async function reload(app: App): Promise<void> {
  await evalIn(app, "location.reload(); true");
  await waitForDiscussionView(app, 120_000);
  await waitFor(app, `Boolean(document.querySelector('textarea[aria-label=${json(`Message ${NAME}`)}]'))`, {
    timeoutMs: 60_000,
    label: `${NAME} discussion composer`,
  });
}

/**
 * The turn is over: the thread is idle again. A slow free model can outlast the
 * view's own two-minute patience, which then reads "Response delayed" beside the
 * reply that did arrive; that is still an idle thread for the journey's purposes.
 */
async function waitForReady(app: App, label: string): Promise<void> {
  await waitFor(app, `(() => {
    const status = document.querySelector('[data-testid="coworker-thread-status"]');
    return status instanceof HTMLElement && status.dataset.state === "idle" && !document.querySelector('[data-testid="coworker-working"]');
  })()`, { timeoutMs: 300_000, label });
}

/** Send one message and wait for the reply that carries `expected`; returns that bubble's text. */
async function ask(app: App, prompt: string, expected: string): Promise<string> {
  await fill(app, `textarea[aria-label="Message ${NAME}"]`, prompt);
  await clickButton(app, "Send");
  await waitFor(app, `(() => [...document.querySelectorAll('[data-message-role="user"]')]
    .some((candidate) => (candidate.textContent ?? "").includes(${json(prompt.slice(0, 60))})))()`, { timeoutMs: 30_000, label: "visible user message" });
  const replyExpression = `(() => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(expected)}));
    return message?.textContent ?? false;
  })()`;
  await waitFor(app, replyExpression, { timeoutMs: 300_000, label: `assistant response ${json(expected)}` });
  await waitForReady(app, `settled after ${json(expected)}`);
  // Read the words again once the turn is over, so a reply still streaming at first sight is measured whole.
  return String(await waitFor(app, replyExpression, { timeoutMs: 30_000, label: `final assistant response ${json(expected)}` }));
}

/** Every step label behind the receipts on screen, opening the closed ones first and letting them render. */
async function receiptSteps(app: App): Promise<string[]> {
  const steps = await evalIn(app, `(async () => {
    for (const summary of document.querySelectorAll('[data-testid="coworker-work-summary"][aria-expanded="false"]')) summary.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      summaries: [...document.querySelectorAll('[data-testid="coworker-work-summary"]')].map((node) => node.textContent?.trim() ?? ""),
      steps: [...document.querySelectorAll('[data-testid="coworker-work-step"] span.truncate')].map((node) => node.textContent?.trim() ?? "").filter(Boolean),
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  if (!isRecord(steps) || !Array.isArray(steps.steps) || !Array.isArray(steps.summaries)) throw new Error("The receipt steps were unavailable.");
  // A receipt whose steps did not render still names its one step in the collapsed line.
  return [...new Set([...steps.steps.map(String), ...steps.summaries.map((line) => String(line).replace(/›$/, "").trim())])];
}

async function documentsOnDisk(app: App): Promise<Record<string, unknown>[]> {
  return resultList(await invokeCoworker(app, "documents.list", { slug: SLUG }));
}

// Seven model turns on a free model under load can outlast the default budget; the journey gets the same room as the Den automation journey.
test.skipIf(!enabled)(title, { timeout: 1_200_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using app = await coworker({ name: "documents" });

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const created = resultRecord(await invokeCoworker(app, "coworkers.create", {
    name: NAME,
    role: "Planning partner",
    mission: "Turn requests into clear plans.",
    avatarColor: "mint",
    avatarGlasses: "round",
  }));
  expect(created.workspaceId).toEqual(expect.any(String));
  await invokeCoworker(app, "coworkers.update", { slug: SLUG, patch: { model: "opencode/big-pickle", modelVariant: "" } });
  await reload(app);
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, {
    timeoutMs: 240_000,
    label: "coworker AI ready before the first message",
  });

  // The coworker's contract and its document tools arrive with the launch, not with a later setup step.
  const agents = resultRecord(await invokeCoworker(app, "coworkers.files.read", { slug: SLUG, path: "AGENTS.md" }));
  expect(String(agents.content)).toContain("## How I talk");
  const config = resultRecord(await invokeCoworker(app, "coworkers.files.read", { slug: SLUG, path: "opencode.json" }));
  expect(JSON.parse(String(config.content)).instructions).toContain("documents/index.md");
  // The tools are registered in the workspace and the engine has connected to them before the first message goes out.
  const toolsRegistered = await waitFor(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const coworker = (await window.__COWORKER__.invoke("coworkers.get", { slug: ${json(SLUG)} })).result;
    const headers = { Authorization: "Bearer " + runtime.ownerToken };
    const base = runtime.serverUrl + "/workspace/" + encodeURIComponent(coworker.workspaceId);
    const registration = await fetch(base + "/mcp", { headers });
    if (!registration.ok) return false;
    const payload = await registration.json();
    const registered = (payload.items ?? []).some((item) => item.name === "coworker");
    if (!registered) return false;
    const engine = await fetch(base + "/opencode/mcp", { headers });
    if (!engine.ok) return false;
    const status = await engine.json();
    return status.coworker?.status === "connected" ? "connected" : false;
  })()`, { timeoutMs: 180_000, label: "document tools registered and connected in the coworker workspace", awaitPromise: true });
  expect(toolsRegistered).toBe("connected");

  // 1. Ask for a plan: a short reply, "Wrote a document · …" in the action line, and a card with Open.
  const planReply = await ask(
    app,
    `Use your document_create tool exactly once to write a document titled "Launch plan" with the summary "Ship onboarding by the end of Q3." and the highlights "Three phases", "Two owners", "One open risk", whose body has exactly three ## sections named Timeline, Owners, and Risks with one short sentence each. After the tool succeeds, reply with exactly PLAN READY and nothing else.`,
    "PLAN READY",
  );
  expect(planReply.length).toBeLessThan(600);
  expect(planReply).not.toContain("## Timeline");
  const planSteps = await receiptSteps(app);
  expect(planSteps).toEqual(expect.arrayContaining([expect.stringMatching(/^Wrote a document · Launch plan$/)]));
  for (const step of planSteps) expect(step).not.toMatch(/document_create|coworker_/);
  const card = await waitFor(app, `(() => {
    const card = document.querySelector('[data-testid="document-card"][data-document-id="launch-plan"]');
    if (!card) return false;
    return {
      action: card.getAttribute("data-action"),
      title: card.querySelector('[data-testid="document-card-title"]')?.textContent?.trim() ?? "",
      summary: card.querySelector('[data-testid="document-card-summary"]')?.textContent?.trim() ?? "",
      highlights: [...card.querySelectorAll('[data-testid="document-card-highlights"] li')].map((node) => node.textContent?.trim() ?? ""),
      open: Boolean(card.querySelector('[data-testid="document-card-open"]')),
      insideBubble: Boolean(card.closest('[data-message-role="assistant"]')),
    };
  })()`, { timeoutMs: 30_000, label: "document card under the reply" });
  expect(card).toMatchObject({ action: "created", title: "Launch plan", summary: "Ship onboarding by the end of Q3.", open: true, insideBubble: true });
  if (!isRecord(card) || !Array.isArray(card.highlights)) throw new Error("Card facts were unavailable.");
  expect(card.highlights).toHaveLength(3);
  const onDisk = await documentsOnDisk(app);
  expect(onDisk).toHaveLength(1);
  expect(onDisk[0]).toMatchObject({ id: "launch-plan", title: "Launch plan", status: "active", revision: 1, updatedBy: "coworker" });
  const index = resultRecord(await invokeCoworker(app, "coworkers.files.read", { slug: SLUG, path: "documents/index.md" }));
  expect(String(index.content)).toContain("- launch-plan — Launch plan — Ship onboarding by the end of Q3.");

  evidence.recordAssertionEvidence(
    "A substantial request gets a short reply, a document, and a card",
    `The reply carrying PLAN READY was ${planReply.length} characters with no section headings pasted in; the action line read ${JSON.stringify(planSteps)}; the bubble ended with a created card titled "Launch plan" with its summary, ${card.highlights.length} highlights, and Open; documents/launch-plan.md exists at revision 1 and documents/index.md lists it.`,
    true,
  );

  // 2. Open shows the rendered document with a table of contents in the Documents view.
  await evalIn(app, `document.querySelector('[data-testid="document-card"][data-document-id="launch-plan"] [data-testid="document-card-open"]').click(); true`);
  const opened = await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    const reader = document.querySelector('[data-testid="document-reader"][data-document-id="launch-plan"]');
    if (!panel || !reader) return false;
    return {
      view: panel.getAttribute("data-view"),
      collapsed: panel.getAttribute("data-collapsed"),
      revision: reader.getAttribute("data-revision"),
      toc: [...reader.querySelectorAll('[data-testid="document-toc"] li')].map((node) => node.textContent?.trim() ?? ""),
      headings: [...reader.querySelectorAll('[data-testid="document-body"] h2')].map((node) => node.textContent?.trim() ?? ""),
      title: reader.querySelector('[data-testid="document-title"]')?.textContent?.trim() ?? "",
    };
  })()`, { timeoutMs: 30_000, label: "Documents view opened on Launch plan" });
  expect(opened).toMatchObject({ view: "documents", collapsed: "false", revision: "1", title: "Launch plan" });
  if (!isRecord(opened) || !Array.isArray(opened.toc) || !Array.isArray(opened.headings)) throw new Error("Reader facts were unavailable.");
  expect(opened.headings).toEqual(["Timeline", "Owners", "Risks"]);
  expect(opened.toc).toEqual(["Timeline", "Owners", "Risks"]);

  // 3. Ask for a change: "Updated … · Timeline section", revision 2, History shows the diff, Restore works.
  const updateReply = await ask(
    app,
    `Use your document_update tool exactly once on the document with id "launch-plan": send a patch for the section with heading "Timeline" whose content is exactly "Week one: research. Week two: build." and the summary "Ship onboarding by mid-Q3." After the tool succeeds, reply with exactly PLAN UPDATED and nothing else.`,
    "PLAN UPDATED",
  );
  expect(updateReply.length).toBeLessThan(600);
  const updateSteps = await receiptSteps(app);
  expect(updateSteps).toEqual(expect.arrayContaining([expect.stringMatching(/^Updated Launch plan · Timeline section$/)]));
  const updatedCard = await waitFor(app, `(() => {
    const cards = [...document.querySelectorAll('[data-testid="document-card"][data-document-id="launch-plan"][data-action="updated"]')];
    const card = cards.at(-1);
    return card ? (card.querySelector('[data-testid="document-card-subline"]')?.textContent?.trim() ?? "") : false;
  })()`, { timeoutMs: 30_000, label: "updated card subline" });
  expect(updatedCard).toBe("Updated · Timeline section");
  await waitFor(app, `document.querySelector('[data-testid="document-reader"][data-document-id="launch-plan"]')?.getAttribute("data-revision") === "2"`, {
    timeoutMs: 30_000,
    label: "reader at revision 2",
  });
  expect(await evalIn(app, `document.querySelector('[data-testid="document-body"]')?.textContent ?? ""`)).toContain("Week two: build.");
  await evalIn(app, `document.querySelector('[data-testid="document-history"]').click(); true`);
  const history = await waitFor(app, `(() => {
    const revisions = [...document.querySelectorAll('[data-testid="document-revision"]')].map((node) => node.getAttribute("data-revision"));
    const summary = document.querySelector('[data-testid="document-diff-summary"]')?.textContent?.trim() ?? "";
    const added = [...document.querySelectorAll('[data-testid="document-diff"] pre[data-kind="added"]')].map((node) => node.textContent ?? "");
    const removed = [...document.querySelectorAll('[data-testid="document-diff"] pre[data-kind="removed"]')].map((node) => node.textContent ?? "");
    return revisions.length > 0 && summary ? { revisions, summary, added, removed } : false;
  })()`, { timeoutMs: 30_000, label: "history with a diff" });
  expect(history).toMatchObject({ revisions: ["1"] });
  if (!isRecord(history) || !Array.isArray(history.added) || !Array.isArray(history.removed)) throw new Error("History facts were unavailable.");
  expect(String(history.summary)).toMatch(/^Revision 1 → current \(revision 2\): \+\d+ −\d+ lines$/);
  expect(history.added.join("\n")).toContain("Week two: build.");
  expect(history.removed.length).toBeGreaterThan(0);
  const revisionOneBody = String(resultList(await invokeCoworker(app, "documents.revisions", { slug: SLUG, id: "launch-plan" }))[0]?.body ?? "");
  await evalIn(app, `document.querySelector('[data-testid="document-restore"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-testid="document-reader"][data-document-id="launch-plan"]')?.getAttribute("data-revision") === "3"`, {
    timeoutMs: 30_000,
    label: "restore produced revision 3",
  });
  const restored = resultRecord(await invokeCoworker(app, "documents.read", { slug: SLUG, id: "launch-plan" }));
  expect(restored.body).toBe(revisionOneBody);
  expect(restored.updatedBy).toBe("person");

  evidence.recordAssertionEvidence(
    "A change request updates one section, and history compares and restores",
    `The action line read ${JSON.stringify(updateSteps)} and the card's subline read "Updated · Timeline section"; the reader moved to revision 2 and showed the new Timeline text; History listed revision 1 with the diff summary "${String(history.summary)}", and Restore produced revision 3 by the person with the revision-1 body.`,
    true,
  );

  // 4. The coworker puts an older document aside; the view's groups follow.
  await ask(
    app,
    `Use your document_create tool once to write a document titled "Old vendor notes" with the summary "Notes from the first vendor round." and a one-paragraph body. Then call your context_set tool once with active ["launch-plan"] and aside ["old-vendor-notes"]. After both tools succeed, reply with exactly ASIDE DONE and nothing else.`,
    "ASIDE DONE",
  );
  const asideSteps = await receiptSteps(app);
  expect(asideSteps).toEqual(expect.arrayContaining([expect.stringMatching(/^Put aside · Old vendor notes$/)]));
  const grouped = await documentsOnDisk(app);
  expect(grouped.find((document) => document.id === "old-vendor-notes")).toMatchObject({ status: "aside" });
  expect(grouped.find((document) => document.id === "launch-plan")).toMatchObject({ status: "active" });
  await evalIn(app, `document.querySelector('[data-testid="document-back"]').click(); true`);
  const groups = await waitFor(app, `(() => {
    const active = [...document.querySelectorAll('[data-testid="documents-active"] [data-testid="document-row"]')].map((node) => node.getAttribute("data-document-id"));
    const aside = document.querySelector('[data-testid="documents-aside"]');
    if (!aside || active.length === 0) return false;
    return { active, asideOpen: aside instanceof HTMLDetailsElement ? aside.open : null, asideLabel: aside.querySelector("summary")?.textContent?.trim() ?? "" };
  })()`, { timeoutMs: 30_000, label: "Active and Put aside groups" });
  expect(groups).toMatchObject({ active: ["launch-plan"], asideOpen: false });
  expect(String(isRecord(groups) ? groups.asideLabel : "")).toContain("Put aside · 1");
  await evalIn(app, `document.querySelector('[data-testid="documents-aside"] summary').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="documents-aside-list"] [data-document-id="old-vendor-notes"]'))`, { timeoutMs: 10_000, label: "put-aside row" });

  // 5. The person edits and saves; the coworker acknowledges the edit next turn.
  await evalIn(app, `document.querySelector('[data-testid="documents-active"] [data-document-id="launch-plan"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="document-reader"][data-document-id="launch-plan"]'))`, { timeoutMs: 10_000, label: "reader again" });
  await clickButton(app, "Edit");
  await fill(app, 'textarea[aria-label="Document Markdown"]', "## Timeline\n\nEdited by hand: launch moves to October.\n\n## Owners\n\nAna and Ben.\n\n## Risks\n\nNone open.\n");
  await evalIn(app, `document.querySelector('[data-testid="document-save"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-testid="document-reader"][data-document-id="launch-plan"]')?.getAttribute("data-revision") === "4"`, { timeoutMs: 30_000, label: "saved as revision 4" });
  const edited = resultRecord(await invokeCoworker(app, "documents.read", { slug: SLUG, id: "launch-plan" }));
  expect(edited).toMatchObject({ updatedBy: "person", revision: 4 });
  const indexAfterEdit = resultRecord(await invokeCoworker(app, "coworkers.files.read", { slug: SLUG, path: "documents/index.md" }));
  expect(String(indexAfterEdit.content)).toContain("edited by the person");
  const acknowledged = await ask(
    app,
    `Look at the documents index you are given every turn. If it says the person edited the document "Launch plan", reply with exactly EDIT SEEN. Otherwise reply with exactly NO EDIT. Do not use any tools.`,
    "EDIT SEEN",
  );
  expect(acknowledged).toContain("EDIT SEEN");

  evidence.recordAssertionEvidence(
    "The coworker keeps the active set and the person's edits are visible to both",
    `context_set read as ${JSON.stringify(asideSteps)} and the view showed Active [launch-plan] with Put aside · 1 closed by default; saving an edit produced revision 4 by the person, the index marked it as edited, and the next reply acknowledged it with EDIT SEEN.`,
    true,
  );

  // 6. Reload keeps everything.
  await reload(app);
  const afterReload = await documentsOnDisk(app);
  expect(afterReload.map((document) => [document.id, document.status, document.revision])).toEqual(expect.arrayContaining([["launch-plan", "active", 4], ["old-vendor-notes", "aside", 1]]));
  await waitFor(app, `Boolean(document.querySelector('[data-testid="document-card"][data-document-id="launch-plan"]'))`, { timeoutMs: 60_000, label: "cards survive reload" });
  await evalIn(app, `document.querySelector('[data-testid="context-rail-documents"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="documents-active"] [data-document-id="launch-plan"]'))`, { timeoutMs: 30_000, label: "Documents view after reload" });

  // 7. A long reply without a document folds to its first paragraph; nothing is lost; the coworker is reminded.
  const foldedBubble = await ask(
    app,
    `Without using any tools, write about 500 words in five paragraphs about the history of the bicycle: the draisine, the penny-farthing, the safety bicycle, pneumatic tyres, and modern e-bikes, with at least three full sentences in each paragraph. Begin the first paragraph with the exact words LONG REPLY START.`,
    "LONG REPLY START",
  );
  // The bubble shows only the lead; the whole reply is measured from the thread itself.
  const fullReply = await evalIn(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const coworker = (await window.__COWORKER__.invoke("coworkers.get", { slug: ${json(SLUG)} })).result;
    const response = await fetch(runtime.serverUrl + "/workspace/" + encodeURIComponent(coworker.workspaceId) + "/opencode/session/" + encodeURIComponent(coworker.conversationThreadId) + "/message", {
      headers: { Authorization: "Bearer " + runtime.ownerToken },
    });
    const messages = await response.json();
    const reply = [...messages].reverse().find((message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "text" && String(part.text ?? "").includes("LONG REPLY START")));
    return reply ? reply.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\\n") : "";
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  const longReply = String(fullReply);
  expect(longReply.length, `a ${longReply.length}-character reply is not long enough to fold`).toBeGreaterThan(1200);
  expect(String(foldedBubble).length).toBeLessThan(longReply.length);
  const fold = await waitFor(app, `(() => {
    const fold = document.querySelector('[data-testid="reply-fold"]');
    if (!fold) return false;
    const toggle = fold.querySelector('[data-testid="reply-fold-toggle"]');
    return { toggle: toggle?.textContent?.trim() ?? "", visibleChars: (fold.querySelector('[data-testid="reply-fold-lead"]')?.textContent ?? "").length };
  })()`, { timeoutMs: 30_000, label: "folded long reply" });
  expect(fold).toMatchObject({ toggle: "Show the rest" });
  if (!isRecord(fold)) throw new Error("Fold facts were unavailable.");
  expect(Number(fold.visibleChars)).toBeLessThan(longReply.length);
  await evalIn(app, `document.querySelector('[data-testid="reply-fold-toggle"]').click(); true`);
  const unfolded = await waitFor(app, `(() => {
    const fold = document.querySelector('[data-testid="reply-fold"][data-open="true"]');
    return fold ? (fold.textContent ?? "").length : false;
  })()`, { timeoutMs: 10_000, label: "unfolded reply" });
  expect(Number(unfolded)).toBeGreaterThan(1200);
  const style = await waitFor(app, `(async () => {
    const response = await window.__COWORKER__.invoke("coworkers.files.read", { slug: ${json(SLUG)}, path: "memory/style.jsonl" });
    return response.ok && String(response.result.content).includes("long-reply") ? response.result.content : false;
  })()`, { timeoutMs: 30_000, label: "style log records the long reply", awaitPromise: true });
  expect(String(style)).toContain("\"kind\":\"long-reply\"");
  const indexWithReminder = resultRecord(await invokeCoworker(app, "coworkers.files.read", { slug: SLUG, path: "documents/index.md" }));
  expect(String(indexWithReminder.content)).toContain("## Reminder");

  evidence.recordAssertionEvidence(
    "Everything survives a reload, and a long reply without a document folds instead of burying the person",
    `After reload both documents kept their status and revision and the card was still under its reply; a ${longReply.length}-character reply with no document showed "Show the rest" over its first paragraph, unfolded to the whole text, was recorded in memory/style.jsonl, and documents/index.md carried the reminder for the coworker's next turn.`,
    true,
  );
});
