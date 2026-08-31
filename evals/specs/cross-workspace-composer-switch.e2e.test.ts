import { expect } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  evalIn,
  readComposerState,
  selectModel,
  sendComposerMessage,
  waitFor,
  writeComposerText,
} from "@openwork/behaviors";
import { screenshot } from "@openwork/test-evidence";
import {
  app,
  eventually,
  localMysqlIsRunning,
  localRedisIsRunning,
  mcpMock,
  needs,
  server,
  sleep,
  test,
} from "@openwork/testkit";
import type { App } from "@openwork/testkit";

const providerId = "composer-switch-mock";
const modelId = "composer-switch-model";
const modelName = "Composer switch model";
// The user-facing budget for "I clicked another chat and can start typing".
const typableBudgetMs = 10_000;
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const configuredDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const localServicesRequired = !daytonaEnabled && !configuredDen;
const mysqlOpen = await localMysqlIsRunning();
const redisOpen = await localRedisIsRunning();
const runnable = e2eTestsEnabled && (!localServicesRequired || (mysqlOpen && redisOpen));
const skipSuffix = !e2eTestsEnabled
  ? " skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : localServicesRequired && !mysqlOpen
    ? " skipped — needs MySQL on 127.0.0.1:3306"
    : localServicesRequired && !redisOpen
      ? " skipped — needs Redis on 127.0.0.1:6379"
      : "";

interface Chat {
  workspaceId: string;
  sessionId: string;
  title: string;
}

async function configureWorkspaces(appSurface: App, workspaceIds: string[], baseUrl: string): Promise<void> {
  const result = await evalIn(appSurface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return "local_server_unavailable";
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    for (const workspaceId of ${JSON.stringify(workspaceIds)}) {
      const configured = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          opencode: {
            permission: { bash: "allow" },
            provider: {
              [${JSON.stringify(providerId)}]: {
                npm: "@ai-sdk/openai-compatible",
                name: ${JSON.stringify(modelName)},
                options: { baseURL: ${JSON.stringify(`${baseUrl}/v1`)}, apiKey: "sk-composer-switch" },
                models: {
                  [${JSON.stringify(modelId)}]: { name: ${JSON.stringify(modelName)}, tool_call: true },
                },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!configured.ok) return "config:" + configured.status + ":" + (await configured.text()).slice(0, 300);
      const reloaded = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(60000),
      });
      if (!reloaded.ok) return "reload:" + reloaded.status + ":" + (await reloaded.text()).slice(0, 300);
    }
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(modelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${providerId}/${modelId}`)});
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  expect(result).toBe("ok");

  await evalIn(appSurface, "location.reload(); true");
  await waitFor(appSurface, "Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "desktop restored after mock provider configuration",
  });
}

async function createSession(appSurface: App): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const created = await control(appSurface, "session.create_task", undefined, { timeoutMs: 30_000 });
      if (typeof created === "string" && created.startsWith("ses_")) return created;
      lastError = new Error(`session.create_task returned ${JSON.stringify(created)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`session.create_task did not return a session id: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function clickSessionRow(appSurface: App, chat: Chat): Promise<void> {
  await waitFor(appSurface, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${chat.sessionId}"][data-sidebar-session-workspace-id="${chat.workspaceId}"]`)});
    const controlEl = row?.querySelector(${JSON.stringify(`[data-session-tab-id="${chat.sessionId}"]`)});
    return row instanceof HTMLElement
      && controlEl instanceof HTMLButtonElement
      && !controlEl.disabled;
  })()`, { timeoutMs: 60_000, label: `clickable sidebar row for ${chat.title}` });

  await evalIn(appSurface, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${chat.sessionId}"][data-sidebar-session-workspace-id="${chat.workspaceId}"]`)});
    const controlEl = row?.querySelector(${JSON.stringify(`[data-session-tab-id="${chat.sessionId}"]`)});
    if (!(row instanceof HTMLElement) || !(controlEl instanceof HTMLButtonElement) || controlEl.disabled) {
      throw new Error(${JSON.stringify(`clickable sidebar row disappeared for ${chat.title} (${chat.workspaceId}/${chat.sessionId})`)});
    }
    row.scrollIntoView({ block: "center" });
    controlEl.click();
    return true;
  })()`);
}

async function waitForChatSurface(appSurface: App, chat: Chat): Promise<void> {
  await waitFor(appSurface, `(() => {
    const surface = document.querySelector("[data-session-surface-id]");
    return surface?.getAttribute("data-session-surface-id") === ${JSON.stringify(chat.sessionId)}
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(chat.workspaceId)};
  })()`, { timeoutMs: 60_000, label: `surface for ${chat.title} after sidebar click` });
}

/**
 * Click a session in the sidebar and measure how long the composer takes to be
 * usable for typing: the target surface is shown, the composer contenteditable
 * is mounted, and a send affordance exists. Returns elapsed milliseconds.
 */
async function switchAndMeasureTypable(appSurface: App, chat: Chat): Promise<number> {
  const startedAt = Date.now();
  await clickSessionRow(appSurface, chat);
  await waitForChatSurface(appSurface, chat);
  await eventually(() => readComposerState(appSurface), {
    within: typableBudgetMs + 20_000,
    intervalMs: 50,
    label: `typable composer in ${chat.title}`,
    until: (state) => state.composerEditable && state.runTaskVisible,
  });
  return Date.now() - startedAt;
}

async function readDraft(appSurface: App): Promise<string> {
  return (await readComposerState(appSurface)).draftText.trim();
}

/**
 * Type into whatever composer is currently mounted, without waiting for
 * readiness, the way a fast user starts typing right after clicking a chat.
 */
async function typeEagerly(appSurface: App, text: string): Promise<boolean> {
  const typed = await evalIn(appSurface, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      ?? document.querySelector('[contenteditable="true"]');
    if (!editor) return false;
    editor.focus();
    document.execCommand("insertText", false, ${JSON.stringify(text)});
    return true;
  })()`);
  return typed === true;
}

test.skipIf(!runnable)(
  `switching chats across workspaces keeps the composer prompt-ready and drafts isolated${skipSuffix}`,
  { timeout: 15 * 60_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
    const runId = `${Date.now().toString(36)}-${process.pid}`;
    const sendMarker = `COMPOSER-SWITCH-SEND-${runId}`;
    const completionMarker = `DONE-${sendMarker}`;

    await using den = await server({
      place,
      mocks: {
        agent: mcpMock({
          agentWorkloads: [{
            promptMarker: sendMarker,
            finalReply: completionMarker,
            steps: [{
              tool: "bash",
              arguments: {
                command: `printf '%s\\n' 'ACK-${sendMarker}'`,
                timeout: 30_000,
                description: "Acknowledge the composer switch prompt",
              },
            }],
          }],
        }),
      },
      org: {
        name: "Composer Switch",
        admin: { name: "Switch Admin" },
        members: { member: { name: "Switch Member" } },
      },
    });
    await using desktopApp = await app({ den, as: "member", place });

    // Two workspaces, two chats each: four retained chats, matching the
    // "3-5 active sessions" complaint shape.
    const workspaceB = await createAndSelectWorkspace(desktopApp, {
      path: `/tmp/openwork-composer-switch-${runId}-b`,
    });
    const chatB1: Chat = { workspaceId: workspaceB.workspaceId, sessionId: await createSession(desktopApp), title: "Chat B1" };
    const chatB2: Chat = { workspaceId: workspaceB.workspaceId, sessionId: await createSession(desktopApp), title: "Chat B2" };

    const workspaceA = await createAndSelectWorkspace(desktopApp, {
      path: `/tmp/openwork-composer-switch-${runId}-a`,
    });
    const chatA1: Chat = { workspaceId: workspaceA.workspaceId, sessionId: await createSession(desktopApp), title: "Chat A1" };
    const chatA2: Chat = { workspaceId: workspaceA.workspaceId, sessionId: await createSession(desktopApp), title: "Chat A2" };

    for (const chat of [chatB1, chatB2, chatA1, chatA2]) {
      await control(desktopApp, "session.rename", { sessionId: chat.sessionId, title: chat.title }, { timeoutMs: 30_000 });
    }
    expect(new Set([chatA1, chatA2, chatB1, chatB2].map((chat) => chat.sessionId)).size).toBe(4);

    await configureWorkspaces(desktopApp, [workspaceA.workspaceId, workspaceB.workspaceId], den.mocks.agent.url);
    await clickSessionRow(desktopApp, chatA1);
    await waitForChatSurface(desktopApp, chatA1);
    const selected = await selectModel(desktopApp, modelId);
    expect(selected.id).toBe(modelId);

    // Claim 1: every cross-workspace chat click reaches a typable composer
    // within the budget, repeatedly, with all four chats retained.
    const rotation = [chatB1, chatA2, chatB2, chatA1, chatB1, chatA1, chatB2, chatA2];
    const switchTimings: { title: string; ms: number }[] = [];
    for (const chat of rotation) {
      const ms = await switchAndMeasureTypable(desktopApp, chat);
      switchTimings.push({ title: chat.title, ms });
    }
    const slowest = Math.max(...switchTimings.map((timing) => timing.ms));
    evidence.recordAssertionEvidence(
      "Every cross-workspace chat switch reaches a typable composer within the budget",
      `${rotation.length} sidebar switches across ${JSON.stringify([workspaceA.workspaceId, workspaceB.workspaceId])}; per-switch ms=${JSON.stringify(switchTimings)}; budget=${typableBudgetMs}ms.`,
      slowest <= typableBudgetMs,
    );
    expect(slowest, `slowest switch-to-typable of ${JSON.stringify(switchTimings)}`).toBeLessThanOrEqual(typableBudgetMs);

    // Claim 2: drafts are isolated per chat. A draft written in one chat is
    // restored when returning to it and never appears in another chat.
    const draftA1 = `draft-a1-${runId}`;
    const draftB1 = `draft-b1-${runId}`;
    await switchAndMeasureTypable(desktopApp, chatA1);
    await writeComposerText(desktopApp, draftA1);
    await switchAndMeasureTypable(desktopApp, chatB1);
    // Let any deferred per-chat draft restore settle before reading.
    await sleep(1_500);
    const draftSeenInB1 = await readDraft(desktopApp);
    expect(draftSeenInB1, "chat B1 must not show chat A1's draft").not.toContain(draftA1);
    await writeComposerText(desktopApp, draftB1);
    await switchAndMeasureTypable(desktopApp, chatA1);
    await sleep(1_500);
    const draftBackInA1 = await readDraft(desktopApp);
    expect(draftBackInA1, "chat A1 restores its own draft").toContain(draftA1);
    expect(draftBackInA1, "chat A1 must not absorb chat B1's draft").not.toContain(draftB1);
    evidence.recordAssertionEvidence(
      "Drafts stay isolated per chat across workspace switches",
      `A1 draft=${JSON.stringify(draftBackInA1)}; B1 observed on arrival=${JSON.stringify(draftSeenInB1)}.`,
      draftBackInA1.includes(draftA1) && !draftBackInA1.includes(draftB1) && !draftSeenInB1.includes(draftA1),
    );

    // Claim 3: text typed immediately after clicking another chat, before the
    // target composer settles, must never leak into a different chat's draft.
    const eagerMarker = `eager-${runId}`;
    await clickSessionRow(desktopApp, chatB2);
    const eagerTyped = await typeEagerly(desktopApp, eagerMarker);
    await waitForChatSurface(desktopApp, chatB2);
    await sleep(1_500);
    const draftInB2 = await readDraft(desktopApp);
    await switchAndMeasureTypable(desktopApp, chatA1);
    await sleep(1_500);
    const draftA1AfterEager = await readDraft(desktopApp);
    await switchAndMeasureTypable(desktopApp, chatB1);
    await sleep(1_500);
    const draftB1AfterEager = await readDraft(desktopApp);
    expect(draftA1AfterEager, "eager keystrokes must not land in chat A1").not.toContain(eagerMarker);
    expect(draftB1AfterEager, "eager keystrokes must not land in chat B1").not.toContain(eagerMarker);
    evidence.recordAssertionEvidence(
      "Keystrokes typed during a chat switch never leak into another chat's draft",
      `typedIntoMountedEditor=${eagerTyped}; target B2 draft=${JSON.stringify(draftInB2)}; A1 draft=${JSON.stringify(draftA1AfterEager)}; B1 draft=${JSON.stringify(draftB1AfterEager)}.`,
      !draftA1AfterEager.includes(eagerMarker) && !draftB1AfterEager.includes(eagerMarker),
    );

    // Claim 4: a cleared draft stays cleared after switching away and back.
    await switchAndMeasureTypable(desktopApp, chatA1);
    await writeComposerText(desktopApp, " ");
    await control(desktopApp, "composer.set_text", { text: "" }, { timeoutMs: 30_000 }).catch(async () => {
      await evalIn(desktopApp, `(() => {
        const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
          ?? document.querySelector('[contenteditable="true"]');
        if (!editor) return false;
        editor.focus();
        document.execCommand("selectAll");
        document.execCommand("delete");
        return true;
      })()`);
    });
    await sleep(1_000);
    const clearedNow = await readDraft(desktopApp);
    await switchAndMeasureTypable(desktopApp, chatB2);
    await switchAndMeasureTypable(desktopApp, chatA1);
    await sleep(1_500);
    const clearedAfterRoundTrip = await readDraft(desktopApp);
    evidence.recordAssertionEvidence(
      "A cleared draft stays cleared after leaving and returning to the chat",
      `Draft right after clearing=${JSON.stringify(clearedNow)}; after round trip=${JSON.stringify(clearedAfterRoundTrip)}.`,
      clearedAfterRoundTrip === "",
    );
    expect(clearedAfterRoundTrip, "chat A1 draft resurrected after clearing").toBe("");

    // Claim 5: sending right after a cross-workspace switch sends exactly the
    // typed text — no stale draft from another chat — and clears the composer.
    await switchAndMeasureTypable(desktopApp, chatB2);
    const prompt = `Reply with the completion for ${sendMarker}.`;
    const afterSend = await sendComposerMessage(desktopApp, prompt);
    const sentMessage = await evalIn(desktopApp, `(() => {
      const messages = [...document.querySelectorAll('[data-message-role="user"]')];
      return messages[messages.length - 1]?.innerText ?? "";
    })()`);
    expect(typeof sentMessage).toBe("string");
    const sentText = String(sentMessage);
    expect(sentText, "sent message contains the typed prompt").toContain(sendMarker);
    expect(sentText, "sent message must not contain another chat's draft").not.toContain(draftA1);
    expect(sentText, "sent message must not contain another chat's draft").not.toContain(draftB1);
    expect(afterSend.draftText.trim(), "composer clears after sending").toBe("");
    evidence.recordAssertionEvidence(
      "A message sent right after a cross-workspace switch carries only the typed text and clears the composer",
      `Sent=${JSON.stringify(sentText)}; draft after send=${JSON.stringify(afterSend.draftText)}; timings=${JSON.stringify(switchTimings)}.`,
      sentText.includes(sendMarker)
        && !sentText.includes(draftA1)
        && !sentText.includes(draftB1)
        && afterSend.draftText.trim() === "",
    );
    await screenshot(desktopApp);
  },
);
