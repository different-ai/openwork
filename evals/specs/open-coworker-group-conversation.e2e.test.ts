import { EVAL_COWORKER_MODEL, clickButton, coworker, evalIn, fill, needs, test, waitFor } from "@openwork/testkit";
import { expect } from "vitest";

/**
 * A group chat reads like a calm group text: the person writes once, the right
 * coworkers answer one after the other (each knowing what the others just
 * said), a silent facilitator decides who and in what order, and nothing is
 * lost on a stop or a reload. This journey drives the packaged app end to end
 * with deterministic prompts on the free model: two coworkers, a group made
 * from the rail, @everyone, a role-matched question, an ordered second round
 * whose second speaker saw the first reply, Stop all, Continue, a reload
 * mid-turn recovered with Continue, then rename and archive.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker group chats answer in order, keep context between speakers, and lose nothing on stop or reload"
  : "Open Coworker group conversation journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const ROLL_CALL = "@everyone Reply with exactly ROLL CALL followed by your own name, and nothing else.";
const RESEARCH_QUESTION = "A research question about checking sources: reply with exactly SOURCES CHECKED and nothing else.";
const SECOND_ROUND = "@Editor @Scout Editor first: reply with exactly ROUND TWO EDITOR. Scout after reading Editor's reply: reply with exactly ROUND TWO SCOUT.";
const MODEL_CHECK = "@everyone Reply with exactly MODEL CHECK followed by your own name, and nothing else.";
const SLOW_STOP = "@everyone Count from 1 to 40, one number per line.";
const SLOW_RELOAD = "@everyone Count down from 40 to 1, one number per line.";

type App = Awaited<ReturnType<typeof coworker>>;

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function invokeCoworker(app: App, command: string, payload?: unknown): Promise<unknown> {
  return evalIn(app, `window.__COWORKER__.invoke(${json(command)}, ${json(payload ?? null)})`, { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

type Speaker = { slug: string; status: string; part: string; order: number; error: string; brief: string; startedAt: number | null; endedAt: number | null };
type Turn = { id: string; status: string; routedBy: string; mode: string; prompt: string; speakers: Speaker[] };

async function readGroup(app: App, groupId: string): Promise<{ name: string; archivedAt: number | null; participantThreadIds: Record<string, string>; facilitatorThreadId: string; turns: Turn[] }> {
  const group = resultRecord(await invokeCoworker(app, "groups.get", { id: groupId }));
  const turns = Array.isArray(group.turns) ? group.turns : [];
  const threadIds = isRecord(group.participantThreadIds) ? group.participantThreadIds : {};
  return {
    name: String(group.name),
    archivedAt: typeof group.archivedAt === "number" ? group.archivedAt : null,
    participantThreadIds: Object.fromEntries(Object.entries(threadIds).map(([slug, id]) => [slug, String(id)])),
    facilitatorThreadId: String(group.facilitatorThreadId ?? ""),
    turns: turns.filter(isRecord).map((turn) => ({
      id: String(turn.id),
      status: String(turn.status),
      routedBy: String(turn.routedBy),
      mode: String(turn.mode),
      prompt: String(turn.prompt),
      speakers: (Array.isArray(turn.speakers) ? turn.speakers : []).filter(isRecord).map((speaker) => ({
        slug: String(speaker.slug),
        status: String(speaker.status),
        part: String(speaker.part),
        order: Number(speaker.order),
        error: String(speaker.error ?? ""),
        brief: String(speaker.brief ?? ""),
        startedAt: typeof speaker.startedAt === "number" ? speaker.startedAt : null,
        endedAt: typeof speaker.endedAt === "number" ? speaker.endedAt : null,
      })),
    })),
  };
}

/** The visible user and assistant texts of one native thread, read through the embedded server's engine proxy. */
async function readThreadTexts(app: App, workspaceId: string, threadId: string): Promise<Array<{ role: string; text: string }>> {
  const value = await evalIn(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const response = await fetch(runtime.serverUrl + "/workspace/" + encodeURIComponent(${json(workspaceId)}) + "/opencode/session/" + encodeURIComponent(${json(threadId)}) + "/message", {
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

/** Every visible line of the group as the person sees it, in order. */
async function readTimeline(app: App): Promise<Array<{ kind: string; speaker: string; text: string; status: string }>> {
  const value = await evalIn(app, `[...document.querySelectorAll('[data-testid="group-chat"] [data-message-role], [data-testid="group-chat"] [data-testid="group-status"], [data-testid="group-chat"] [data-testid="group-action-line"]')]
    .map((node) => ({
      kind: node.getAttribute("data-message-role") ?? node.getAttribute("data-testid") ?? "",
      speaker: node.getAttribute("data-speaker") ?? "",
      text: (node.textContent ?? "").trim(),
      status: node.getAttribute("data-status") ?? "",
    }))`);
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("The group timeline was unavailable.");
  return value.map((entry) => ({ kind: String(entry.kind), speaker: String(entry.speaker), text: String(entry.text), status: String(entry.status) }));
}

async function waitForGroupIdle(app: App, timeoutMs = 300_000): Promise<void> {
  await waitFor(app, `document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "false"`, { timeoutMs, label: "group turn settled" });
}

/** The turn at `index` once the group is idle; a turn that did not succeed fails loudly with each speaker's recorded reason. */
async function settledTurn(app: App, groupId: string, index: number, expectedStatus = "succeeded"): Promise<Turn> {
  await waitForGroupIdle(app);
  const group = await readGroup(app, groupId);
  const turn = group.turns[index];
  if (!turn) throw new Error(`Turn ${index} was not recorded; turns: ${JSON.stringify(group.turns.map((entry) => entry.prompt))}`);
  if (expectedStatus && turn.status !== expectedStatus) {
    throw new Error(`Turn ${index} ("${turn.prompt.slice(0, 40)}") is ${turn.status}, expected ${expectedStatus}; speakers: ${JSON.stringify(turn.speakers)}`);
  }
  return turn;
}

async function sendGroupMessage(app: App, text: string): Promise<void> {
  await fill(app, '[data-testid="group-composer"]', text);
  await evalIn(app, `document.querySelector('[data-testid="group-send"]').click(); true`);
  await waitFor(app, `[...document.querySelectorAll('[data-testid="group-chat"] [data-message-role="user"]')].some((node) => (node.textContent ?? "").includes(${json(text.slice(0, 40))}))`, {
    timeoutMs: 60_000,
    label: `visible group message ${json(text.slice(0, 40))}`,
  });
}

async function openGroupFromRail(app: App, groupId: string): Promise<void> {
  await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="group-rail-row"][data-group-id=${json(groupId)}]');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 60_000, label: "group row in the rail" });
  await waitFor(app, `document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-group-id") === ${json(groupId)}`, { timeoutMs: 30_000, label: "group view" });
}

async function beginStatusTrace(app: App): Promise<void> {
  await evalIn(app, `(() => {
    window.__GROUP_TRACE__?.observer?.disconnect?.();
    const trace = [];
    const record = () => {
      trace.push({
        status: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
        phrase: document.querySelector('[data-testid="group-progress-phrase"]')?.textContent?.trim() ?? "",
        rail: document.querySelector('[data-testid="group-rail-line"]')?.textContent?.trim() ?? "",
      });
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__GROUP_TRACE__ = { trace, observer };
    record();
    return true;
  })()`);
}

async function endStatusTrace(app: App): Promise<Array<{ status: string; phrase: string; rail: string }>> {
  const value = await evalIn(app, `(() => {
    window.__GROUP_TRACE__?.observer?.disconnect?.();
    return window.__GROUP_TRACE__?.trace ?? [];
  })()`);
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("The group status trace was unavailable.");
  return value.map((entry) => ({ status: String(entry.status), phrase: String(entry.phrase), rail: String(entry.rail) }));
}

test.skipIf(!enabled)(title, { timeout: 1_500_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using app = await coworker({ name: "group-conversation" });

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const scout = resultRecord(await invokeCoworker(app, "coworkers.create", { name: "Scout", role: "Research partner", mission: "Find and check sources for the team.", avatarColor: "blue", avatarGlasses: "round" }));
  const editor = resultRecord(await invokeCoworker(app, "coworkers.create", { name: "Editor", role: "Writing partner", mission: "Shape drafts into clear writing.", avatarColor: "mint", avatarGlasses: "square" }));
  const workspaces: Record<string, string> = { scout: String(scout.workspaceId), editor: String(editor.workspaceId) };
  expect(workspaces.scout).not.toBe("");
  expect(workspaces.editor).not.toBe("");
  for (const slug of ["scout", "editor"]) {
    await invokeCoworker(app, "coworkers.update", { slug, patch: { model: EVAL_COWORKER_MODEL, modelVariant: "" } });
  }
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]')) && document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, {
    timeoutMs: 240_000,
    label: "coworkers ready",
  });
  const names: Record<string, string> = { scout: "Scout", editor: "Editor" };

  // --- A group of two from the rail, named from the roles.
  await evalIn(app, `document.querySelector('[data-testid="new-group-chat"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="new-group-sheet"]'))`, { timeoutMs: 30_000, label: "new group sheet" });
  const suggestedName = await evalIn(app, `document.querySelector('[data-testid="new-group-name"]')?.value ?? ""`);
  expect(suggestedName).toBe("Writing & Research");
  const preselected = await evalIn(app, `[...document.querySelectorAll('[data-testid="new-group-member"][aria-checked="true"]')].map((node) => node.getAttribute("data-slug"))`);
  expect(preselected).toEqual(["editor", "scout"]);
  await clickButton(app, "Create group chat");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-chat"]')) && Boolean(document.querySelector('[data-testid="group-chat-empty"]'))`, { timeoutMs: 30_000, label: "empty group view" });
  const groupId = String(await evalIn(app, `document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-group-id") ?? ""`));
  expect(groupId).toMatch(/^grp_/);
  expect(await evalIn(app, `document.querySelector('[data-testid="group-name"]')?.textContent?.trim()`)).toBe("Writing & Research");

  // --- @everyone: both answer, one after the other, each signed with name and avatar.
  await beginStatusTrace(app);
  await sendGroupMessage(app, ROLL_CALL);
  const rollCallTurn = await settledTurn(app, groupId, 0);
  const rollCallTrace = await endStatusTrace(app);
  let group = await readGroup(app, groupId);
  expect(rollCallTurn.speakers.filter((speaker) => speaker.part === "reply").map((speaker) => speaker.slug).sort()).toEqual(["editor", "scout"]);
  expect(["facilitator", "mentions"]).toContain(rollCallTurn.routedBy);
  let timeline = await readTimeline(app);
  const rollCallReplies = timeline.filter((line) => line.kind === "assistant");
  expect(rollCallReplies).toHaveLength(2);
  // The bubbles appear in the recorded speaking order, and each carries the right coworker's words.
  expect(rollCallReplies.map((line) => line.speaker)).toEqual(rollCallTurn.speakers.filter((speaker) => speaker.part === "reply").map((speaker) => speaker.slug));
  for (const line of rollCallReplies) {
    expect(line.text).toContain("ROLL CALL");
    expect(line.text).toContain(names[line.speaker] ?? "?");
  }
  const signatures = await evalIn(app, `[...document.querySelectorAll('[data-testid="group-chat"] [data-message-role="assistant"]')].map((node) => ({
    name: node.querySelector('[data-testid="group-speaker-name"]')?.textContent?.trim() ?? "",
    avatar: node.querySelector('[role="img"]')?.getAttribute("aria-label") ?? "",
  }))`);
  expect(signatures).toEqual(rollCallReplies.map((line) => ({ name: names[line.speaker], avatar: `${names[line.speaker]} avatar` })));
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="group-time-label"]').length`)).toBeGreaterThan(0);
  const phrases = [...new Set(rollCallTrace.map((entry) => entry.phrase).filter(Boolean))];
  expect(phrases.some((phrase) => /^(Choosing who should respond…|(Scout|Editor|Scout and Editor|Editor and Scout) (is|are) replying…( then (Scout|Editor))?)$/.test(phrase)), `live phrases: ${JSON.stringify(phrases)}`).toBe(true);
  expect(rollCallTrace.some((entry) => /is replying…|are replying…|Choosing who should respond…/.test(entry.rail)), `rail lines: ${JSON.stringify([...new Set(rollCallTrace.map((entry) => entry.rail))])}`).toBe(true);
  const lastSpeaker = rollCallReplies[rollCallReplies.length - 1]?.speaker ?? "";
  expect(await evalIn(app, `document.querySelector('[data-testid="group-rail-line"]')?.textContent?.trim()`)).toBe(`${names[lastSpeaker]} replied`);
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim()`)).toBe("Ready");

  evidence.recordAssertionEvidence(
    "@everyone makes both coworkers answer in order, each signed, with a live row and rail line that say who is replying",
    `Group ${groupId} was created from the rail as "Writing & Research" with Editor and Scout preselected. ROLL CALL was answered by ${rollCallReplies.map((line) => names[line.speaker]).join(" then ")} (routed by ${rollCallTurn.routedBy}, mode ${rollCallTurn.mode}); each bubble carried the speaker's own name, a name label, and its avatar; a time label was shown; live phrases seen: ${JSON.stringify(phrases)}; the rail ended on "${names[lastSpeaker]} replied".`,
    true,
  );

  // --- A role-matched question: exactly one coworker answers.
  await sendGroupMessage(app, RESEARCH_QUESTION);
  const researchTurn = await settledTurn(app, groupId, 1);
  expect(researchTurn.speakers.filter((speaker) => speaker.part === "reply")).toHaveLength(1);
  timeline = await readTimeline(app);
  const researchReplies = timeline.filter((line) => line.kind === "assistant").slice(2);
  expect(researchReplies).toHaveLength(researchTurn.speakers.length);
  expect(researchReplies[0]?.text).toContain("SOURCES CHECKED");
  expect(researchReplies[0]?.speaker).toBe(researchTurn.speakers[0]?.slug);

  evidence.recordAssertionEvidence(
    "A question with no name gets exactly one speaker",
    `"${RESEARCH_QUESTION}" was answered by ${names[researchTurn.speakers[0]?.slug ?? ""] ?? "?"} alone (routed by ${researchTurn.routedBy}${researchTurn.speakers[0]?.brief ? `, brief: "${researchTurn.speakers[0].brief}"` : ""}); the timeline gained one bubble containing SOURCES CHECKED.`,
    true,
  );

  // --- Two names: the facilitator (or the fallback) keeps the set and orders it; a sequential second speaker is told the first's reply.
  await sendGroupMessage(app, SECOND_ROUND);
  const secondRound = await settledTurn(app, groupId, 2);
  group = await readGroup(app, groupId);
  const roundSpeakers = secondRound.speakers.filter((speaker) => speaker.part === "reply");
  expect(roundSpeakers.map((speaker) => speaker.slug).sort()).toEqual(["editor", "scout"]);
  const [firstSpeaker, secondSpeaker] = roundSpeakers;
  if (!firstSpeaker || !secondSpeaker) throw new Error("Two speakers were expected.");
  timeline = await readTimeline(app);
  const roundReplies = timeline.filter((line) => line.kind === "assistant").slice(-2);
  // Bubbles settle in the recorded order whether the two ran one after the other or at once.
  expect(roundReplies.map((line) => line.speaker)).toEqual([firstSpeaker.slug, secondSpeaker.slug]);
  for (const line of roundReplies) expect(line.text).toContain("ROUND TWO");
  const secondThread = group.participantThreadIds[secondSpeaker.slug];
  if (!secondThread) throw new Error("The second speaker has no group thread.");
  const secondTranscript = await readThreadTexts(app, workspaces[secondSpeaker.slug] ?? "", secondThread);
  const secondPrompt = [...secondTranscript].reverse().find((message) => message.role === "user")?.text ?? "";
  expect(secondPrompt).toContain("Your part in this reply:");
  expect(secondPrompt).not.toContain("was stopped");
  expect(secondPrompt).toMatch(/The person's message: @Editor @Scout Editor first: reply with exactly ROUND TWO EDITOR/);
  if (secondRound.mode === "sequential") {
    expect(secondPrompt).toContain("Already said in reply to this message:");
    expect(secondPrompt).toContain(`- ${names[firstSpeaker.slug]}: `);
  } else {
    // Independent replies ran at once: both started before either finished, and neither waited for the other.
    const started = roundSpeakers.map((speaker) => speaker.startedAt ?? 0);
    const firstEnd = Math.min(...roundSpeakers.map((speaker) => speaker.endedAt ?? Number.MAX_SAFE_INTEGER));
    expect(started.every((at) => at > 0 && at <= firstEnd), JSON.stringify(roundSpeakers)).toBe(true);
    expect(secondPrompt).not.toContain("Already said in reply to this message:");
  }
  if (secondRound.routedBy === "facilitator") expect(group.facilitatorThreadId).toMatch(/^ses_/);

  evidence.recordAssertionEvidence(
    "Two named coworkers keep the set, answer in the chosen order, and a sequential second speaker is told what the first said",
    `ROUND TWO was answered by ${names[firstSpeaker.slug]} then ${names[secondSpeaker.slug]} (routed by ${secondRound.routedBy}, mode ${secondRound.mode}${firstSpeaker.brief ? `, briefs: "${firstSpeaker.brief}" / "${secondSpeaker.brief}"` : ""}); the second speaker's native group thread ${secondThread} holds a prompt with its own part and the person's message and no status lines${secondRound.mode === "sequential" ? `, plus "Already said in reply to this message: - ${names[firstSpeaker.slug]}: …"` : "; the facilitator judged the two replies independent, so they ran at once and settled in its order"}.${secondRound.routedBy === "facilitator" ? ` The facilitator ran on native thread ${group.facilitatorThreadId} in the hidden coordinator workspace.` : " The deterministic scorer decided this turn."}`,
    true,
  );

  // --- One coworker's model is unavailable: the other still answers, the failure names the fix, and Retry
  // (after the fix) asks only that coworker — with the reply that already landed in its prompt.
  await invokeCoworker(app, "coworkers.update", { slug: "editor", patch: { model: "missing-provider/missing-model", modelVariant: "" } });
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 120_000, label: "app after the model change" });
  await openGroupFromRail(app, groupId);
  await waitFor(app, `[...document.querySelectorAll('[data-testid="group-chat"] [data-message-role="assistant"]')].length >= 5`, { timeoutMs: 60_000, label: "timeline back after reload" });
  await sendGroupMessage(app, MODEL_CHECK);
  const failedTurn = await settledTurn(app, groupId, 3, "partial");
  const failedSpeaker = failedTurn.speakers.find((speaker) => speaker.slug === "editor");
  const fineSpeaker = failedTurn.speakers.find((speaker) => speaker.slug === "scout");
  expect(failedSpeaker?.status, JSON.stringify(failedTurn.speakers)).toBe("failed");
  expect(fineSpeaker?.status, JSON.stringify(failedTurn.speakers)).toBe("succeeded");
  expect(failedSpeaker?.error).toContain("missing-provider/missing-model");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-speaker-retry"][data-speaker="editor"]'))`, { timeoutMs: 30_000, label: "Retry on Editor's failure line" });
  timeline = await readTimeline(app);
  const failureLine = timeline.find((line) => line.kind === "group-status" && line.status === "failed" && line.speaker === "editor");
  expect(failureLine?.text).toContain("Editor's AI model is not available.");
  expect(failureLine?.text).toContain("Retry");
  expect(failureLine?.text).toContain("Choose AI model");
  expect(failureLine?.text).not.toMatch(/engine|APIError|stack/i);
  expect(timeline.filter((line) => line.kind === "assistant").at(-1)?.speaker).toBe("scout");
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="group-turn-continue"]'))`)).toBe(false);

  await invokeCoworker(app, "coworkers.update", { slug: "editor", patch: { model: EVAL_COWORKER_MODEL, modelVariant: "" } });
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 120_000, label: "app after the model fix" });
  await openGroupFromRail(app, groupId);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-speaker-retry"][data-speaker="editor"]'))`, { timeoutMs: 60_000, label: "Retry for Editor" });
  await evalIn(app, `document.querySelector('[data-testid="group-speaker-retry"][data-speaker="editor"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "true"`, { timeoutMs: 30_000, label: "Retry started" });
  const retriedTurn = await settledTurn(app, groupId, 3);
  expect(retriedTurn.speakers.map((speaker) => speaker.status)).toEqual(retriedTurn.speakers.map(() => "succeeded"));
  group = await readGroup(app, groupId);
  const editorThread = group.participantThreadIds.editor;
  if (!editorThread) throw new Error("Editor has no group thread.");
  const editorTranscript = await readThreadTexts(app, workspaces.editor ?? "", editorThread);
  const retryPrompt = [...editorTranscript].reverse().find((message) => message.role === "user")?.text ?? "";
  expect(retryPrompt).toContain("Already said in reply to this message:");
  expect(retryPrompt).toMatch(/- Scout: .*MODEL CHECK/);
  expect(retryPrompt).toMatch(/The person's message: @everyone Reply with exactly MODEL CHECK/);
  timeline = await readTimeline(app);
  const modelCheckReplies = timeline.filter((line) => line.kind === "assistant" && line.text.includes("MODEL CHECK"));
  expect(modelCheckReplies.map((line) => line.speaker)).toEqual(["scout", "editor"]);
  expect(timeline.filter((line) => line.kind === "assistant" && line.speaker === "scout" && line.text.includes("MODEL CHECK"))).toHaveLength(1);

  evidence.recordAssertionEvidence(
    "One coworker's unavailable model never blocks the other, the failure names the fix, and Retry asks only that coworker with the earlier reply in hand",
    `With Editor on missing-provider/missing-model, MODEL CHECK was answered by Scout while Editor's line read "Editor's AI model is not available." with Retry and Choose AI model (the turn recorded partial, Editor's reason kept the exact model id). After the model was restored, Retry asked Editor alone: its native thread ${editorThread} holds a prompt with "Already said in reply to this message: - Scout: MODEL CHECK …", Scout was not asked again, and the turn is succeeded.`,
    true,
  );

  // --- Stop all while the first coworker is still counting: the rest are marked stopped, and Continue is offered.
  await sendGroupMessage(app, SLOW_STOP);
  await waitFor(app, `document.querySelector('[data-testid="group-working"]')?.getAttribute("data-phase") === "running"`, { timeoutMs: 120_000, label: "a coworker replying" });
  await clickButton(app, "Stop all");
  const stoppedTurn = await settledTurn(app, groupId, 4, "");
  expect(["stopped", "partial"], `stopped turn: ${JSON.stringify(stoppedTurn.speakers)}`).toContain(stoppedTurn.status);
  const stoppedSpeakers = stoppedTurn.speakers.filter((speaker) => speaker.status === "stopped");
  expect(stoppedSpeakers.length).toBeGreaterThan(0);
  expect(stoppedTurn.speakers.every((speaker) => speaker.status === "stopped" || speaker.status === "succeeded")).toBe(true);
  timeline = await readTimeline(app);
  const stopLines = timeline.filter((line) => line.kind === "group-status" && line.status === "stopped");
  expect(stopLines.map((line) => line.text)).toEqual([`Stopped before ${stoppedSpeakers.map((speaker) => names[speaker.slug]).join(" and ")} replied.`]);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-turn-continue"]'))`, { timeoutMs: 30_000, label: "Continue offered" });
  const stoppedBubblesBefore = timeline.filter((line) => line.kind === "assistant").length;

  evidence.recordAssertionEvidence(
    "Stop all ends the turn at once and marks the rest stopped without losing what was said",
    `${SLOW_STOP} was stopped while ${names[stoppedTurn.speakers.find((speaker) => speaker.status === "running" || speaker.status === "stopped")?.slug ?? ""] ?? "a coworker"} was replying; the turn is ${stoppedTurn.status} with ${stoppedSpeakers.length} stopped speaker(s) (${stoppedSpeakers.map((speaker) => names[speaker.slug]).join(", ")}), one quiet "${stopLines[0]?.text ?? ""}" line, and a Continue control.`,
    true,
  );

  // --- Continue finishes the stopped turn with the same message; nobody who replied is asked again.
  await evalIn(app, `document.querySelector('[data-testid="group-turn-continue"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "true"`, { timeoutMs: 30_000, label: "Continue started" });
  const continuedTurn = await settledTurn(app, groupId, 4);
  expect(continuedTurn.speakers.map((speaker) => speaker.status)).toEqual(continuedTurn.speakers.map(() => "succeeded"));
  timeline = await readTimeline(app);
  const continuedBubbles = timeline.filter((line) => line.kind === "assistant");
  expect(continuedBubbles.length).toBe(stoppedBubblesBefore + stoppedSpeakers.length);
  const continuedReplies = continuedBubbles.slice(-stoppedSpeakers.length);
  expect(continuedReplies.map((line) => line.speaker).sort()).toEqual(stoppedSpeakers.map((speaker) => speaker.slug).sort());
  for (const line of continuedReplies) expect(line.text).toMatch(/\d/);
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="group-turn-continue"]'))`)).toBe(false);

  evidence.recordAssertionEvidence(
    "Continue lets the stopped coworkers reply to the same message and only them",
    `After Continue the turn is succeeded; ${stoppedSpeakers.length} new counted reply bubble(s) arrived from ${continuedReplies.map((line) => names[line.speaker]).join(" and ")}, the earlier bubbles were untouched (${stoppedBubblesBefore} before, ${continuedBubbles.length} after), and Continue disappeared.`,
    true,
  );

  // --- A reload mid-turn: the timeline is kept, the cut-off turn is settled with one quiet line, and Continue finishes it.
  await sendGroupMessage(app, SLOW_RELOAD);
  await waitFor(app, `document.querySelector('[data-testid="group-working"]')?.getAttribute("data-phase") === "running"`, { timeoutMs: 120_000, label: "a coworker replying before reload" });
  const bubblesBeforeReload = (await readTimeline(app)).filter((line) => line.kind === "assistant").length;
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 120_000, label: "app after reload" });
  await openGroupFromRail(app, groupId);
  await waitFor(app, `[...document.querySelectorAll('[data-testid="group-status"]')].some((node) => (node.textContent ?? "").includes("Stopped when the app closed"))`, { timeoutMs: 60_000, label: "interrupted turn settled" });
  group = await readGroup(app, groupId);
  const interruptedTurn = group.turns[5];
  if (!interruptedTurn) throw new Error("The interrupted turn was not recorded.");
  expect(interruptedTurn.status).toBe("partial");
  const interruptedSpeakers = interruptedTurn.speakers.filter((speaker) => speaker.status === "stopped");
  expect(interruptedSpeakers.length).toBeGreaterThan(0);
  for (const speaker of interruptedSpeakers) expect(speaker.error).toBe("Stopped when the app closed");
  timeline = await readTimeline(app);
  expect(timeline.filter((line) => line.kind === "assistant").length).toBe(bubblesBeforeReload);
  expect(timeline.some((line) => line.text.includes("ROLL CALL"))).toBe(true);
  const interruptedLine = timeline.find((line) => line.status === "interrupted");
  expect(interruptedLine?.text).toMatch(/^Stopped when the app closed before (Scout|Editor|Scout and Editor|Editor and Scout) replied\./);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-turn-continue"]'))`, { timeoutMs: 30_000, label: "Continue after reload" });
  await evalIn(app, `document.querySelector('[data-testid="group-turn-continue"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "true"`, { timeoutMs: 30_000, label: "Continue after reload started" });
  await settledTurn(app, groupId, 5);
  timeline = await readTimeline(app);
  const recoveredReplies = timeline.filter((line) => line.kind === "assistant").slice(-interruptedSpeakers.length);
  expect(recoveredReplies.map((line) => line.speaker).sort()).toEqual(interruptedSpeakers.map((speaker) => speaker.slug).sort());
  for (const line of recoveredReplies) expect(line.text).toMatch(/\d/);

  evidence.recordAssertionEvidence(
    "A reload mid-turn loses nothing: the timeline is kept, the cut-off turn is settled, and Continue finishes it",
    `After reloading while a coworker was replying, the group kept its ${bubblesBeforeReload} earlier bubbles, the turn became partial with ${interruptedSpeakers.length} speaker(s) marked "Stopped when the app closed", the timeline showed "${interruptedLine?.text ?? ""}", and Continue finished it with a counted reply from ${recoveredReplies.map((line) => names[line.speaker]).join(" and ")}.`,
    true,
  );

  // --- Rename and archive from the header's overflow.
  await evalIn(app, `document.querySelector('[aria-label="Group chat options"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[role="menu"][aria-label="Group chat options"]'))`, { timeoutMs: 10_000, label: "group options menu" });
  await clickButton(app, "Rename");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-name-input"]'))`, { timeoutMs: 10_000, label: "rename field" });
  await fill(app, '[data-testid="group-name-input"]', "Launch desk");
  await evalIn(app, `document.querySelector('[data-testid="group-name-input"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true`);
  await waitFor(app, `document.querySelector('[data-testid="group-name"]')?.textContent?.trim() === "Launch desk"`, { timeoutMs: 30_000, label: "renamed group" });
  expect((await readGroup(app, groupId)).name).toBe("Launch desk");
  await evalIn(app, `document.querySelector('[aria-label="Group chat options"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[role="menu"][aria-label="Group chat options"]'))`, { timeoutMs: 10_000, label: "group options menu again" });
  await clickButton(app, "Archive");
  await waitFor(app, `!document.querySelector('[data-testid="group-chat"]') && !document.querySelector('[data-testid="group-rail-row"][data-group-id=${json(groupId)}]')`, { timeoutMs: 30_000, label: "group archived" });
  const archived = await readGroup(app, groupId);
  expect(archived.archivedAt).toEqual(expect.any(Number));
  expect(archived.turns.length).toBe(6);
  const storedTimeline = await invokeCoworker(app, "groups.readTimeline", { id: groupId });
  expect(Array.isArray(isRecord(storedTimeline) ? storedTimeline.result : null) ? (storedTimeline as { result: unknown[] }).result.length : 0).toBeGreaterThan(10);

  evidence.recordAssertionEvidence(
    "Rename and archive keep the group's history readable",
    `The group was renamed to "Launch desk" from the header's menu and archived; it left the rail, its record keeps all 6 turns, and its timeline is intact on disk.`,
    true,
  );
});
