import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { coworker, needs, test } from "@openwork/testkit";
import { expect } from "vitest";

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

async function reload(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await evalIn(app, "location.reload(); true");
  await waitForText(app, "Discussion with Editor", { timeoutMs: 120_000 });
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
  await using app = await coworker({ name: "persistent-discussion" });

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
    patch: { model: "opencode/big-pickle", modelVariant: "" },
  });
  await reload(app);

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
  expect(beforeReply.every((entry) => entry.topStatus !== "Ready")).toBe(true);

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

  const assignmentButtonText = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").startsWith("Assignments"));
    return button?.textContent?.trim() ?? "";
  })()`);
  expect(assignmentButtonText).toBe("Assignments");
  await clickButton(app, "Assignments");
  await waitForText(app, "No assignments yet", { timeoutMs: 30_000 });
  expect(await evalIn(app, "document.body.innerText")).not.toContain("COWORKER CHAT READY\nJust now");
  await clickButton(app, "←");
  await waitForText(app, "SECOND CHAT READY", { timeoutMs: 30_000 });

  evidence.recordAssertionEvidence(
    "A coworker's discussion waits for a matched reply and survives reload without becoming an assignment",
    `The first user message became visible, the UI exposed a real working interval with no Ready status before the matched assistant response, and native discussion ${discussionThreadId} persisted across reload and a second turn while the assignment count remained zero.`,
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
  const failureText = await waitFor(app, `(() => {
    const failure = document.querySelector('[data-testid="coworker-turn-failed"]');
    return failure?.textContent ?? false;
  })()`, { timeoutMs: 120_000, label: "actionable failed discussion turn" });
  expect(failureText).toContain("The coworker could not reply");
  expect(failureText).toContain("missing-provider/missing-model");
  expect(failureText).toContain("Choose another model or reconnect its provider");
  expect(failureText).toContain("Open model settings");
  expect(failureText).toContain("Continue with OpenWork");
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim()`)).toBe("Failed");
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim()`)).toBe("Failed");
  expect(await evalIn(app, `(() => [...document.querySelectorAll('[data-message-role="user"]')]
    .some((message) => (message.textContent ?? "").includes(${json(failurePrompt)})))()`)).toBe(true);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId).toBe(discussionThreadId);
  await clickButton(app, "Open model settings");
  await waitForText(app, "Coworker settings", { timeoutMs: 30_000 });
  await waitForText(app, "This saved model is not currently available from a connected provider.", { timeoutMs: 30_000 });

  evidence.recordAssertionEvidence(
    "An invalid coworker model becomes a visible recovery state instead of a silent Ready thread",
    "The failed turn kept the user's prompt visible, named the exact unavailable model, showed the failure as Failed in both the thread header and the coworker header, explained model reconnection with a direct Open model settings action and an OpenWork account action, and preserved the same discussion id.",
    true,
  );
});
