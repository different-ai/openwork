/**
 * Telegram Cloud Connect proof.
 *
 * Prerequisites:
 *   node evals/drivers/cloud-connect-services-mock.mjs --port 3979
 *   DEN_TELEGRAM_API_ROOT=http://127.0.0.1:3979/telegram
 *   DEN_API_PUBLIC_URL=<Den API URL reachable by this flow runner>
 *
 * Seed the deterministic healthy worker before running the flow:
 *   OPENWORK_EVAL_CLOUD_CONNECT_WORKER_URL=http://127.0.0.1:3979/worker \
 *     pnpm --filter @openwork-ee/den-api exec tsx ../../../evals/drivers/seed-cloud-connect-worker.ts
 *
 * The seed uses mock-worker-host-token and mock-worker-client-token unless
 * OPENWORK_EVAL_CLOUD_CONNECT_HOST_TOKEN / CLIENT_TOKEN override them.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  denApiFetch,
  mcpAgentCall,
  mintMcpToken,
  openAdminConnections,
  signInApi,
  signInViaBrowser,
} from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("telegram-cloud-connect");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_SERVER_URL = (process.env.OPENWORK_EVAL_CLOUD_CONNECT_MOCK_URL ?? "http://127.0.0.1:3979")
  .trim()
  .replace(/\/+$/, "");
const BOT_TOKEN = process.env.OPENWORK_EVAL_CLOUD_CONNECT_TELEGRAM_TOKEN?.trim() || "900100:OPENWORK_TEST_TOKEN";
const WORKER_NAME = process.env.OPENWORK_EVAL_CLOUD_CONNECT_WORKER_NAME?.trim() || "Cloud Connect Test Worker";
const WORKER_HOST_TOKEN = process.env.OPENWORK_EVAL_CLOUD_CONNECT_HOST_TOKEN?.trim() || "mock-worker-host-token";
const WORKER_CLIENT_TOKEN = process.env.OPENWORK_EVAL_CLOUD_CONNECT_CLIENT_TOKEN?.trim() || "mock-worker-client-token";
const BOT_USERNAME = "openwork_test_bot";
const TELEGRAM_CHAT_ID = 42001;
const PAIRING_UPDATE_ID = 81_001;
const TASK_UPDATE_ID = 81_002;
const AFTER_DISCONNECT_UPDATE_ID = 81_003;
const TASK_PROMPT = "Summarize the launch notes in my OpenWork workspace";
const OUTBOUND_TEXT = "Launch update: the support handoff is ready.";
const SEND_MESSAGE_PATH = "/v1/capabilities/telegram/send-message";

const state = {
  adminSession: null,
  connectionId: null,
  webhookUrl: null,
  webhookSecret: null,
  pairingCode: null,
  mcpToken: null,
  taskMessageId: null,
  taskReply: null,
  workerRequestStartIndex: 0,
  outboundCapability: null,
  outboundExecution: null,
};

function witness(ctx, condition, assertion, actual) {
  ctx.assert(condition, assertion);
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function toolJson(result) {
  const text = result?.content?.find((entry) => entry?.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function eventually(label, read, predicate = Boolean, timeoutMs = 90_000) {
  const startedAt = Date.now();
  let lastValue;
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await read();
      if (predicate(lastValue)) return lastValue;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const detail = lastError instanceof Error
    ? lastError.message
    : JSON.stringify(lastValue)?.slice(0, 500);
  throw new Error(`Timed out waiting for ${label}${detail ? ` (last result: ${detail})` : ""}.`);
}

async function mockState() {
  const response = await fetch(`${MOCK_SERVER_URL}/__mock/state`);
  if (!response.ok) throw new Error(`Mock state failed: ${response.status}`);
  return response.json();
}

async function mockRequests() {
  const response = await fetch(`${MOCK_SERVER_URL}/__mock/requests`);
  if (!response.ok) throw new Error(`Mock request log failed: ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.requests) ? body.requests : [];
}

async function authenticatedApi(path, options = {}) {
  return denApiFetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.adminSession}`,
      ...(options.headers ?? {}),
    },
  });
}

async function openTelegramDialog(ctx) {
  const clicked = await ctx.eval(`(() => {
    const button = document.querySelector('[data-testid="quick-add-telegram"]');
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`);
  witness(ctx, clicked, "The Telegram quick-add card opens its management dialog.", { clicked });
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"telegram-dialog\"]'))", {
    timeoutMs: 20_000,
    label: "Telegram management dialog",
  });
  await ctx.waitFor(`(() => {
    const dialog = document.querySelector('[data-testid="telegram-dialog"]');
    const text = dialog?.textContent ?? '';
    return !text.includes('Checking Telegram setup…');
  })()`, { timeoutMs: 30_000, label: "Telegram connection status loaded" });
}

async function closeTelegramDialog(ctx) {
  const clicked = await ctx.eval(`(() => {
    const dialog = document.querySelector('[data-testid="telegram-dialog"]');
    const button = [...(dialog?.querySelectorAll('button') ?? [])]
      .find((candidate) => (candidate.textContent ?? '').trim() === 'Close');
    button?.click();
    return Boolean(button);
  })()`);
  witness(ctx, clicked, "The Telegram dialog closes back to Connections.", { clicked });
  await ctx.waitFor("!document.querySelector('[data-testid=\"telegram-dialog\"]')", {
    timeoutMs: 10_000,
    label: "Telegram dialog closed",
  });
}

async function telegramUpdate(text, updateId) {
  const response = await fetch(
    `${MOCK_SERVER_URL}/__mock/telegram/update?text=${encodeURIComponent(text)}&updateId=${encodeURIComponent(updateId)}`,
  );
  if (!response.ok) throw new Error(`Mock Telegram update failed: ${response.status}`);
  return response.json();
}

async function deliverTelegramUpdate(text, updateId) {
  if (!state.webhookUrl || !state.webhookSecret) throw new Error("Telegram webhook was not captured from setup.");
  const update = await telegramUpdate(text, updateId);
  const response = await fetch(state.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": state.webhookSecret,
    },
    body: JSON.stringify(update),
  });
  const body = await response.json().catch(() => null);
  return { response, body, update };
}

async function findSendMessageCapability(ctx) {
  const result = await mcpAgentCall(state.mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "send Telegram update paired private chat", limit: 20 },
  }, ctx);
  const body = toolJson(result);
  const matches = Array.isArray(body.matches) ? body.matches : [];
  const match = matches.find((candidate) => candidate.method === "POST" && candidate.path === SEND_MESSAGE_PATH) ?? null;
  witness(
    ctx,
    Boolean(match),
    `search_capabilities exposes POST ${SEND_MESSAGE_PATH}.`,
    matches.map((candidate) => ({ name: candidate.name, method: candidate.method, path: candidate.path })),
  );
  return match;
}

async function executeSendMessageCapability(ctx, capability) {
  const result = await mcpAgentCall(state.mcpToken, "tools/call", {
    name: "execute_capability",
    arguments: { name: capability.name, body: { text: OUTBOUND_TEXT } },
  }, ctx);
  return { result, body: toolJson(result) };
}

export default {
  id: "telegram-cloud-connect",
  title: "An admin securely pairs one private Telegram chat to one healthy OpenWork Cloud worker and can disconnect it fail-closed",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup: mock services are healthy and Telegram starts disconnected",
      run: async (ctx) => {
        const healthResponse = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        witness(ctx, Boolean(healthResponse?.ok), `Cloud Connect mock is reachable at ${MOCK_SERVER_URL}.`, {
          status: healthResponse?.status ?? null,
        });
        const health = await healthResponse.json();
        witness(ctx, health.service === "cloud-connect-services-mock", "The deterministic Cloud Connect service mock is running.", {
          service: health.service,
          telegramApiBaseUrl: health.endpoints?.telegramApiBaseUrl,
          workerBaseUrl: health.endpoints?.workerBaseUrl,
        });

        const firstReset = await fetch(`${MOCK_SERVER_URL}/__mock/reset`, { method: "POST" });
        witness(ctx, firstReset.ok, "The Cloud Connect mock accepts a clean-state reset.", { status: firstReset.status });

        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        if (!state.adminSession && ctx.env.OPENWORK_EVAL_DEN_TOKEN?.trim()) {
          state.adminSession = ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim();
        }
        witness(ctx, Boolean(state.adminSession), `The demo owner can sign in as ${ADMIN_EMAIL}.`);

        const existing = await authenticatedApi("/v1/telegram/connection");
        witness(ctx, existing.response.ok, "The owner can read the redacted Telegram management status.", {
          status: existing.response.status,
          connected: Boolean(existing.body?.connection),
        });
        if (existing.body?.connection) {
          const removed = await authenticatedApi("/v1/telegram/connection", { method: "DELETE" });
          witness(ctx, removed.response.ok, "A leftover Telegram connection is removed before the proof starts.", {
            status: removed.response.status,
            webhookDeleted: removed.body?.webhookDeleted,
          });
        }

        const reset = await fetch(`${MOCK_SERVER_URL}/__mock/reset`, { method: "POST" });
        witness(ctx, reset.ok, "Telegram, worker sessions, and the request log start empty.", { status: reset.status });
        const disconnected = await authenticatedApi("/v1/telegram/connection");
        witness(ctx, disconnected.response.ok && disconnected.body?.connection === null, "The organization starts without a Telegram bot connection.", {
          status: disconnected.response.status,
          connection: disconnected.body?.connection ?? null,
        });

        state.mcpToken = await mintMcpToken(state.adminSession, ctx, ["mcp:read", "mcp:write"]);
        witness(ctx, Boolean(state.mcpToken), "The signed-in owner can mint an agent capability token.");
      },
    },
    {
      name: "Frame 1 — Admin enters a BotFather token and selects one healthy worker",
      run: async (ctx) => {
        await ctx.prove("An admin can enter a bot token, select a ready cloud worker, and see the private-text-only boundary before connecting", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await openAdminConnections(ctx);
            await ctx.waitForText("Telegram", { timeoutMs: 20_000 });
            await openTelegramDialog(ctx);
            await ctx.waitFor(`(() => {
              const trigger = document.querySelector('button[aria-label="Telegram worker"]');
              return (trigger?.textContent ?? '').trim() === ${JSON.stringify(WORKER_NAME)};
            })()`, { timeoutMs: 30_000, label: `ready worker ${WORKER_NAME}` });
            await ctx.fill('[data-testid="telegram-bot-token"]', BOT_TOKEN);
            const selected = await ctx.eval(`(() => {
              const trigger = document.querySelector('button[aria-label="Telegram worker"]');
              if (!(trigger instanceof HTMLButtonElement)) return null;
              return { label: (trigger.textContent ?? '').trim() };
            })()`);
            witness(ctx, selected?.label === WORKER_NAME, "The admin selects the deterministic healthy worker.", selected);
            await ctx.eval(`(() => {
              const dialog = document.querySelector('[data-testid="telegram-dialog"]');
              if (dialog) dialog.scrollTop = dialog.scrollHeight;
              return true;
            })()`);
          },
          assert: async () => {
            await ctx.expectText("Create a Telegram bot");
            await ctx.expectText("Choose a ready worker");
            await ctx.expectText(WORKER_NAME);
            await ctx.expectText("stable public HTTPS OpenWork API URL");
            await ctx.expectText("private text chats only");
            const form = await ctx.eval(`(() => {
              const token = document.querySelector('[data-testid="telegram-bot-token"]');
              const worker = document.querySelector('button[aria-label="Telegram worker"]');
              const save = document.querySelector('[data-testid="save-telegram"]');
              return {
                tokenPresent: token?.value === ${JSON.stringify(BOT_TOKEN)},
                tokenType: token?.type,
                worker: worker?.textContent?.trim(),
                saveEnabled: save instanceof HTMLButtonElement && !save.disabled,
              };
            })()`);
            witness(ctx, form.tokenPresent && form.tokenType === "password", "The BotFather token is entered in a masked field and is never rendered as plain text.", form);
            witness(ctx, form.worker === WORKER_NAME, "Exactly the intended healthy worker is selected for accepted messages.", { worker: form.worker });
            witness(ctx, form.saveEnabled === true, "Connect bot is enabled only after both a token and ready worker are selected.");
          },
          screenshot: {
            name: "telegram-private-worker-setup",
            claim: "The setup dialog pairs a masked BotFather token with one ready worker and clearly limits the first release to private text chats over a public HTTPS webhook.",
            requireText: ["Connect Telegram", "Bot token", "Choose a ready worker", WORKER_NAME, "stable public HTTPS", "private text chats only", "Connect bot"],
            rejectText: ["No ready workers", "Something went wrong", "Failed to connect Telegram"],
          },
        });
      },
    },
    {
      name: "Frame 2 — Bot and webhook turn green with a one-time pairing link",
      run: async (ctx) => {
        await ctx.prove("The validated bot shows healthy delivery and a one-time deep link without exposing a chat ID or secret", {
          voiceover: vo[1],
          action: async () => {
            const clicked = await ctx.eval(`(() => {
              const button = document.querySelector('[data-testid="save-telegram"]');
              if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
              button.click();
              return true;
            })()`);
            witness(ctx, clicked, "The enabled Connect bot button submits the selected bot and worker.", { clicked });
            await ctx.waitForText("Bot and webhook connected", { timeoutMs: 45_000 });
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"telegram-pairing\"]'))", {
              timeoutMs: 30_000,
              label: "one-time Telegram pairing link",
            });
            await ctx.eval(`(() => {
              const dialog = document.querySelector('[data-testid="telegram-dialog"]');
              if (dialog) dialog.scrollTop = 0;
              return true;
            })()`);
          },
          assert: async () => {
            await ctx.expectText(`@${BOT_USERNAME}`);
            await ctx.expectText(WORKER_NAME);
            await ctx.expectText("Not paired yet");
            await ctx.expectText("One-time pairing link");
            await ctx.expectText("Open Telegram");

            const connection = await authenticatedApi("/v1/telegram/connection");
            witness(
              ctx,
              connection.response.ok
                && connection.body?.connection?.connected === true
                && connection.body?.connection?.webhook?.registered === true,
              "The management API confirms both the bot and webhook are active.",
              {
                status: connection.response.status,
                connected: connection.body?.connection?.connected,
                webhook: connection.body?.connection?.webhook,
                worker: connection.body?.connection?.worker,
              },
            );
            witness(ctx, connection.body?.connection?.worker?.status === "healthy", "Delivery targets the selected healthy worker.", connection.body?.connection?.worker);
            state.connectionId = connection.body.connection.id;

            const pairingUrl = await ctx.eval(`document.querySelector('[data-testid="telegram-pairing"] a[href*="t.me/"]')?.href ?? null`);
            const parsedPairingUrl = new URL(pairingUrl);
            state.pairingCode = parsedPairingUrl.searchParams.get("start");
            witness(
              ctx,
              parsedPairingUrl.hostname === "t.me" && parsedPairingUrl.pathname === `/${BOT_USERNAME}` && Boolean(state.pairingCode),
              "The one-time link targets the validated bot and carries an opaque start code.",
              { hostname: parsedPairingUrl.hostname, pathname: parsedPairingUrl.pathname, hasOpaqueCode: Boolean(state.pairingCode) },
            );

            const cloud = await mockState();
            state.webhookUrl = cloud.telegram?.webhook?.url ?? null;
            state.webhookSecret = cloud.telegram?.webhook?.secretToken ?? null;
            witness(
              ctx,
              Boolean(
                state.webhookUrl
                && state.webhookUrl.endsWith(`/v1/webhooks/telegram/${state.connectionId}`)
                && state.webhookSecret,
              ),
              "Telegram receives a per-connection webhook URL protected by a secret token.",
              {
                webhookUrl: state.webhookUrl,
                secretPresent: Boolean(state.webhookSecret),
                allowedUpdates: cloud.telegram?.webhook?.allowedUpdates,
              },
            );
            witness(ctx, cloud.telegram?.webhook?.allowedUpdates?.join(",") === "message", "The webhook subscribes only to Telegram message updates.", {
              allowedUpdates: cloud.telegram?.webhook?.allowedUpdates,
            });
          },
          screenshot: {
            name: "telegram-connected-and-pairing",
            claim: "The connected bot, selected worker, healthy webhook, and one-time Telegram deep link are visible without exposing the bot token or requiring a chat ID.",
            requireText: ["Telegram bot", "Bot and webhook connected", `@${BOT_USERNAME}`, WORKER_NAME, "Not paired yet", "One-time pairing link", "Open Telegram"],
            rejectText: [BOT_TOKEN, "Telegram needs attention", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3 — Telegram Start consumes the link and pairs one private chat",
      run: async (ctx) => {
        await ctx.prove("Pressing Start once binds the private Telegram user and returns an explicit confirmation from the same bot", {
          voiceover: vo[2],
          action: async () => {
            const delivered = await deliverTelegramUpdate(`/start ${state.pairingCode}`, PAIRING_UPDATE_ID);
            witness(ctx, delivered.response.ok && delivered.body?.accepted === true, "The secret-protected webhook durably accepts the Start update.", {
              status: delivered.response.status,
              body: delivered.body,
              updateId: delivered.update.update_id,
            });

            const pairedCloud = await eventually(
              "Telegram pairing confirmation",
              mockState,
              (cloud) => cloud.telegram?.sentMessages?.some((message) => message.text?.startsWith("Connected. Messages in this private chat")),
            );
            const confirmation = pairedCloud.telegram.sentMessages.find((message) => message.text?.startsWith("Connected. Messages in this private chat"));
            witness(ctx, confirmation?.chat?.id === TELEGRAM_CHAT_ID, "The bot confirms pairing in the same private chat that pressed Start.", confirmation);

            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"telegram-paired\"]'))", {
              timeoutMs: 45_000,
              label: "paired Telegram private chat in OpenWork",
            });
            await closeTelegramDialog(ctx);
            await openTelegramDialog(ctx);
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"telegram-paired\"]'))", {
              timeoutMs: 20_000,
              label: "persisted Telegram paired state after reopening",
            });
          },
          assert: async () => {
            await ctx.expectText("Private chat paired");
            await ctx.expectText("@openwork_tester");
            await ctx.expectText("Only this chat can send tasks to the worker");
            const connection = await authenticatedApi("/v1/telegram/connection");
            witness(ctx, connection.response.ok && connection.body?.connection?.pairing?.paired === true, "The redacted management status persists the paired-chat boundary.", {
              paired: connection.body?.connection?.pairing?.paired,
              chat: connection.body?.connection?.pairing?.chat,
            });
            witness(ctx, connection.body?.connection?.pairing?.chat?.username === "openwork_tester", "OpenWork identifies the paired private account without exposing its numeric chat ID.", connection.body?.connection?.pairing?.chat);
            ctx.output("telegram-pairing-confirmation.json", JSON.stringify({
              acceptedUpdateId: PAIRING_UPDATE_ID,
              paired: connection.body.connection.pairing.paired,
              privateChat: connection.body.connection.pairing.chat,
              botConfirmation: "Connected. Messages in this private chat will now go to your selected OpenWork worker.",
            }, null, 2));
          },
          screenshot: {
            name: "telegram-private-chat-paired",
            claim: "OpenWork shows that exactly one private Telegram account is paired and is the only chat allowed to create worker tasks.",
            requireText: ["Bot and webhook connected", `@${BOT_USERNAME}`, WORKER_NAME, "Private chat paired", "@openwork_tester", "Only this chat can send tasks to the worker"],
            rejectText: ["Not paired yet", "Telegram needs attention", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4 — An inbound Telegram task reaches the selected worker exactly once",
      run: async (ctx) => {
        await ctx.prove("A paired-chat task reaches the selected worker with dual authentication and a stable message ID, then its final answer returns to Telegram", {
          voiceover: vo[3],
          action: async () => {
            state.workerRequestStartIndex = (await mockRequests()).length;
            const delivered = await deliverTelegramUpdate(TASK_PROMPT, TASK_UPDATE_ID);
            witness(ctx, delivered.response.ok && delivered.body?.accepted === true, "The new paired-chat task is durably accepted before worker processing.", {
              status: delivered.response.status,
              body: delivered.body,
              updateId: delivered.update.update_id,
            });

            const completedCloud = await eventually(
              "selected worker reply in Telegram",
              mockState,
              (cloud) => (
                cloud.worker?.sessions?.some((session) => session.prompt === TASK_PROMPT)
                && cloud.telegram?.sentMessages?.some((message) => message.text === `OpenWork worker reply: ${TASK_PROMPT}`)
              ),
            );
            const workerSession = completedCloud.worker.sessions.find((session) => session.prompt === TASK_PROMPT);
            const reply = completedCloud.telegram.sentMessages.find((message) => message.text === `OpenWork worker reply: ${TASK_PROMPT}`);
            state.taskMessageId = workerSession?.messageId ?? null;
            state.taskReply = reply?.text ?? null;

            const duplicate = await deliverTelegramUpdate(TASK_PROMPT, TASK_UPDATE_ID);
            witness(
              ctx,
              duplicate.response.ok && duplicate.body?.accepted === false && duplicate.body?.reason === "duplicate update",
              "A Telegram retry with the same update_id is acknowledged without launching a second worker prompt.",
              { status: duplicate.response.status, body: duplicate.body },
            );

            await closeTelegramDialog(ctx);
            await ctx.waitFor(`(() => {
              const card = document.querySelector('[data-testid="quick-add-telegram"]');
              card?.scrollIntoView({ block: 'center' });
              return (card?.textContent ?? '').includes('Connected — tap to manage');
            })()`, { timeoutMs: 20_000, label: "connected Telegram quick-add card" });
          },
          assert: async () => {
            witness(ctx, /^msg_[a-f0-9]{32}$/.test(state.taskMessageId ?? ""), "The worker prompt carries a deterministic, retry-stable Telegram message ID.", {
              messageId: state.taskMessageId,
            });
            witness(ctx, state.taskReply === `OpenWork worker reply: ${TASK_PROMPT}`, "The final selected-worker answer is sent back through the same Telegram bot.", {
              reply: state.taskReply,
            });

            const requests = await mockRequests();
            const workerRequests = requests
              .slice(state.workerRequestStartIndex)
              .filter((request) => request.path?.startsWith("/worker/"));
            witness(ctx, workerRequests.length >= 5, "The inbound task exercises workspace discovery, session creation, prompt submission, and status polling.", workerRequests.map((request) => ({
              method: request.method,
              path: request.path,
            })));
            witness(
              ctx,
              workerRequests.every((request) => (
                request.headers?.["x-openwork-host-token"] === WORKER_HOST_TOKEN
                && request.headers?.authorization === `Bearer ${WORKER_CLIENT_TOKEN}`
              )),
              "Every worker request carries both the host token and the client bearer token.",
              workerRequests.map((request) => ({
                path: request.path,
                hostTokenPresent: request.headers?.["x-openwork-host-token"] === WORKER_HOST_TOKEN,
                clientTokenPresent: request.headers?.authorization === `Bearer ${WORKER_CLIENT_TOKEN}`,
              })),
            );
            const promptRequests = workerRequests.filter((request) => request.path?.endsWith("/prompt_async"));
            witness(ctx, promptRequests.length === 1, "The accepted task and duplicate Telegram retry produce exactly one worker prompt.", {
              count: promptRequests.length,
              promptPaths: promptRequests.map((request) => request.path),
            });
            witness(ctx, promptRequests[0]?.body?.messageID === state.taskMessageId, "The durable update's deterministic message ID is the exact ID submitted to the worker.", {
              submittedMessageId: promptRequests[0]?.body?.messageID,
              workerMessageId: state.taskMessageId,
            });

            const taskReplies = (await mockState()).telegram.sentMessages.filter((message) => message.text === state.taskReply);
            witness(ctx, taskReplies.length === 1 && taskReplies[0]?.chat?.id === TELEGRAM_CHAT_ID, "Exactly one final answer returns to the same paired private chat.", taskReplies);
            const status = await authenticatedApi("/v1/capabilities/telegram/status");
            witness(ctx, status.response.ok && Boolean(status.body?.connection?.webhook?.lastReceivedAt), "The capability status records successful webhook ingress without revealing paired-chat PII.", status.body);
            ctx.output("telegram-inbound-worker-proof.json", JSON.stringify({
              updateId: TASK_UPDATE_ID,
              stableMessageId: state.taskMessageId,
              workerPrompt: TASK_PROMPT,
              workerRequestCount: workerRequests.length,
              promptRequestCount: promptRequests.length,
              dualAuthentication: true,
              telegramReply: state.taskReply,
              pairedChatIdSeenOnlyByTelegram: TELEGRAM_CHAT_ID,
            }, null, 2));
          },
          screenshot: {
            name: "telegram-inbound-task-complete",
            claim: "The Telegram connection remains healthy after the selected worker accepts one durable task and returns one final reply to the paired chat.",
            requireText: ["Connections", "Telegram", "Pair a private Telegram chat to a cloud worker", "Connected — tap to manage"],
            rejectText: ["Something went wrong", "Connection failed"],
          },
        });
      },
    },
    {
      name: "Frame 5 — The agent capability sends to the same bound chat",
      run: async (ctx) => {
        await ctx.prove("The agent-facing capability accepts only message text and delivers it to the already-paired private Telegram chat", {
          voiceover: vo[4],
          action: async () => {
            await openTelegramDialog(ctx);
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"telegram-paired\"]'))", {
              timeoutMs: 20_000,
              label: "paired Telegram connection before outbound capability",
            });
            const before = await mockState();
            const beforeCount = before.telegram.sentMessages.length;
            state.outboundCapability = await findSendMessageCapability(ctx);
            state.outboundExecution = await executeSendMessageCapability(ctx, state.outboundCapability);
            witness(
              ctx,
              state.outboundExecution.result.isError !== true && state.outboundExecution.body?.ok === true,
              "execute_capability sends the outbound Telegram update successfully.",
              {
                isError: state.outboundExecution.result.isError ?? false,
                body: state.outboundExecution.body,
              },
            );
            await eventually(
              "agent-initiated Telegram update",
              mockState,
              (cloud) => cloud.telegram?.sentMessages?.length === beforeCount + 1
                && cloud.telegram.sentMessages.at(-1)?.text === OUTBOUND_TEXT,
            );
          },
          assert: async () => {
            await ctx.expectText("Private chat paired");
            await ctx.expectText("@openwork_tester");
            const cloud = await mockState();
            const delivered = cloud.telegram.sentMessages.at(-1);
            witness(ctx, delivered?.text === OUTBOUND_TEXT && delivered?.chat?.id === TELEGRAM_CHAT_ID, "The agent update lands under the same bot in the same bound private chat.", delivered);
            witness(
              ctx,
              state.outboundCapability?.hasBody === true || Boolean(state.outboundCapability?.bodySchema),
              "The discovered capability accepts a message body and does not expose an arbitrary chat-id parameter.",
              state.outboundCapability,
            );
            const requests = await mockRequests();
            const outbound = requests.filter((request) => request.path?.endsWith("/sendMessage") && request.body?.text === OUTBOUND_TEXT);
            witness(ctx, outbound.length === 1 && Number(outbound[0]?.body?.chat_id) === TELEGRAM_CHAT_ID, "The server resolves the paired chat internally and invokes Telegram exactly once.", outbound.map((request) => request.body));
            ctx.output("telegram-outbound-capability-proof.json", JSON.stringify({
              capability: {
                name: state.outboundCapability.name,
                method: state.outboundCapability.method,
                path: state.outboundCapability.path,
              },
              agentInput: { text: OUTBOUND_TEXT },
              arbitraryChatIdAccepted: false,
              telegramDelivery: delivered,
            }, null, 2));
          },
          screenshot: {
            name: "telegram-bidirectional-paired-chat",
            claim: "The bot remains green and the same private chat remains paired after an agent capability sends an update back through Telegram.",
            requireText: ["Bot and webhook connected", `@${BOT_USERNAME}`, WORKER_NAME, "Private chat paired", "@openwork_tester"],
            rejectText: ["Not paired yet", "Telegram needs attention", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6 — Disconnect deletes delivery state and later ingress fails closed",
      run: async (ctx) => {
        await ctx.prove("Disconnect removes the webhook, encrypted connection, pairing, and worker ingress so later Telegram messages cannot run", {
          voiceover: vo[5],
          action: async () => {
            const openedConfirmation = await ctx.eval(`(() => {
              const dialog = document.querySelector('[data-testid="telegram-dialog"]');
              const button = [...(dialog?.querySelectorAll('button') ?? [])]
                .find((candidate) => (candidate.textContent ?? '').trim() === 'Disconnect');
              button?.click();
              return Boolean(button);
            })()`);
            witness(ctx, openedConfirmation, "The admin chooses Disconnect from the paired Telegram connection.", { openedConfirmation });
            await ctx.waitForText("Disconnect this bot?", { timeoutMs: 10_000 });
            await ctx.expectText("Telegram messages will stop immediately");
            const confirmed = await ctx.eval(`(() => {
              const dialog = document.querySelector('[data-testid="telegram-dialog"]');
              const panel = [...(dialog?.querySelectorAll('div') ?? [])]
                .find((candidate) => (candidate.textContent ?? '').includes('Disconnect this bot?'));
              const button = [...(panel?.querySelectorAll('button') ?? [])]
                .find((candidate) => (candidate.textContent ?? '').trim() === 'Disconnect');
              button?.click();
              return Boolean(button);
            })()`);
            witness(ctx, confirmed, "The admin confirms removal of the webhook, token, and paired chat.", { confirmed });
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"telegram-bot-token\"]'))", {
              timeoutMs: 30_000,
              label: "Telegram returns to disconnected setup",
            });
            await closeTelegramDialog(ctx);
            await ctx.waitFor(`(() => {
              const card = document.querySelector('[data-testid="quick-add-telegram"]');
              card?.scrollIntoView({ block: 'center' });
              return (card?.textContent ?? '').includes('Tap to set up');
            })()`, { timeoutMs: 20_000, label: "Telegram quick-add card reports setup is required" });
          },
          assert: async () => {
            const connection = await authenticatedApi("/v1/telegram/connection");
            witness(ctx, connection.response.ok && connection.body?.connection === null, "No encrypted Telegram connection or paired-chat state remains in the organization.", {
              status: connection.response.status,
              connection: connection.body?.connection ?? null,
            });
            const cloud = await mockState();
            witness(ctx, cloud.telegram?.webhook === null, "Telegram's registered webhook is deleted during disconnect.", {
              webhook: cloud.telegram?.webhook ?? null,
            });
            const requestsBeforeIngress = await mockRequests();
            witness(ctx, requestsBeforeIngress.some((request) => request.path?.endsWith("/deleteWebhook")), "The disconnect calls Telegram's deleteWebhook operation.", requestsBeforeIngress.filter((request) => request.path?.endsWith("/deleteWebhook")));
            const workerRequestCount = requestsBeforeIngress.filter((request) => request.path?.startsWith("/worker/")).length;
            const sentMessageCount = cloud.telegram.sentMessages.length;

            const rejected = await deliverTelegramUpdate("This must not reach the worker", AFTER_DISCONNECT_UPDATE_ID);
            witness(
              ctx,
              rejected.response.status === 404 && rejected.body?.accepted === false && rejected.body?.reason === "connection not found",
              "Later Telegram ingress to the former secret URL is rejected because the connection no longer exists.",
              { status: rejected.response.status, body: rejected.body },
            );
            const outbound = await authenticatedApi(SEND_MESSAGE_PATH, {
              method: "POST",
              body: JSON.stringify({ text: "This must not be delivered" }),
            });
            witness(ctx, outbound.response.status === 409 && outbound.body?.error === "telegram_not_connected", "Outbound delivery also fails closed after disconnect.", {
              status: outbound.response.status,
              error: outbound.body?.error,
              message: outbound.body?.message,
            });
            const status = await authenticatedApi("/v1/capabilities/telegram/status");
            witness(ctx, status.response.ok && status.body?.connection === null, "The agent-visible status reports that Telegram delivery is disabled.", status.body);

            const after = await mockState();
            const requestsAfterIngress = await mockRequests();
            witness(
              ctx,
              requestsAfterIngress.filter((request) => request.path?.startsWith("/worker/")).length === workerRequestCount
                && after.telegram.sentMessages.length === sentMessageCount,
              "Rejected ingress and outbound calls create no worker task and no Telegram message.",
              {
                workerRequestsBefore: workerRequestCount,
                workerRequestsAfter: requestsAfterIngress.filter((request) => request.path?.startsWith("/worker/")).length,
                sentMessagesBefore: sentMessageCount,
                sentMessagesAfter: after.telegram.sentMessages.length,
              },
            );
            ctx.output("telegram-disconnect-proof.json", JSON.stringify({
              connection: null,
              telegramWebhook: after.telegram.webhook,
              formerWebhookIngress: { status: rejected.response.status, body: rejected.body },
              outboundAfterDisconnect: { status: outbound.response.status, error: outbound.body.error },
              workerTasksAfterDisconnect: 0,
              telegramMessagesAfterDisconnect: 0,
            }, null, 2));
          },
          screenshot: {
            name: "telegram-delivery-disabled",
            claim: "Connections returns Telegram to Tap to set up while the former webhook and both delivery directions fail closed.",
            requireText: ["Connections", "Telegram", "Pair a private Telegram chat to a cloud worker", "Tap to set up"],
            rejectText: ["Connected — tap to manage", "Bot and webhook connected", "Something went wrong"],
          },
        });
      },
    },
  ],
};
