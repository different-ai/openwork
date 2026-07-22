import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudConnectMockServer,
  MOCK_MICROSOFT_ACCESS_TOKEN,
  MOCK_TELEGRAM_BOT_TOKEN,
  MOCK_WORKER_CLIENT_TOKEN,
  MOCK_WORKER_HOST_TOKEN,
} from "./cloud-connect-services-mock.mjs";

async function json(response) {
  return response.json();
}

test("Telegram Bot API validates the bot and captures outbound messages", async (context) => {
  const mock = createCloudConnectMockServer();
  const { origin } = await mock.start();
  context.after(() => mock.stop());

  const meResponse = await fetch(`${origin}/telegram/bot${encodeURIComponent(MOCK_TELEGRAM_BOT_TOKEN)}/getMe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(meResponse.status, 200);
  assert.equal((await json(meResponse)).result.username, "openwork_test_bot");

  const sendResponse = await fetch(`${origin}/telegram/bot${encodeURIComponent(MOCK_TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: 42001, text: "Cloud connection ready" }),
  });
  assert.equal(sendResponse.status, 200);

  const state = await json(await fetch(`${origin}/__mock/state`));
  assert.equal(state.telegram.sentMessages[0].text, "Cloud connection ready");
});

test("Microsoft OAuth redirects with state and Graph serves deterministic mail, calendar, and files", async (context) => {
  const mock = createCloudConnectMockServer();
  const { origin } = await mock.start();
  context.after(() => mock.stop());

  const authorizeUrl = new URL(`${origin}/entra/organizations/oauth2/v2.0/authorize`);
  authorizeUrl.searchParams.set("redirect_uri", `${origin}/callback`);
  authorizeUrl.searchParams.set("state", "state-from-openwork");
  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizeResponse.status, 302);
  const callback = new URL(authorizeResponse.headers.get("location"));
  assert.equal(callback.searchParams.get("code"), "mock-microsoft-authorization-code");
  assert.equal(callback.searchParams.get("state"), "state-from-openwork");

  const headers = { authorization: `Bearer ${MOCK_MICROSOFT_ACCESS_TOKEN}` };
  const messages = await json(await fetch(`${origin}/graph/v1.0/me/messages?$top=3`, { headers }));
  assert.deepEqual(messages.value.map((message) => message.subject), [
    "Launch readiness",
    "Q3 budget approved",
    "Customer feedback summary",
  ]);

  const events = await json(await fetch(`${origin}/graph/v1.0/me/calendarView`, { headers }));
  assert.equal(events.value[0].subject, "Launch review");

  const files = await json(await fetch(`${origin}/graph/v1.0/me/drive/root/search(q='Q3')`, { headers }));
  assert.equal(files.value[0].name, "Q3 Plan.txt");
  const content = await fetch(`${origin}/graph/v1.0/me/drive/items/file-q3-plan/content`, { headers });
  assert.match(await content.text(), /Ship cloud connections/);
});

test("worker mock rejects partial credentials and completes a prompt after a busy snapshot", async (context) => {
  const mock = createCloudConnectMockServer();
  const { origin } = await mock.start();
  context.after(() => mock.stop());

  const partial = await fetch(`${origin}/worker/workspaces`, {
    headers: { "x-openwork-host-token": MOCK_WORKER_HOST_TOKEN },
  });
  assert.equal(partial.status, 401);

  const headers = {
    "x-openwork-host-token": MOCK_WORKER_HOST_TOKEN,
    authorization: `Bearer ${MOCK_WORKER_CLIENT_TOKEN}`,
  };
  const workspaces = await json(await fetch(`${origin}/worker/workspaces`, { headers }));
  assert.equal(workspaces.activeId, "ws_mock_cloud");

  const session = await json(await fetch(`${origin}/worker/workspace/ws_mock_cloud/opencode/session`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: "Telegram chat" }),
  }));

  const prompt = await fetch(`${origin}/worker/workspace/ws_mock_cloud/opencode/session/${session.id}/prompt_async`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "Summarize the launch notes" }] }),
  });
  assert.equal(prompt.status, 204);

  const snapshotUrl = `${origin}/worker/workspace/ws_mock_cloud/sessions/${session.id}/snapshot`;
  const busy = await json(await fetch(snapshotUrl, { headers }));
  assert.equal(busy.item.status.type, "busy");
  const idle = await json(await fetch(snapshotUrl, { headers }));
  assert.equal(idle.item.status.type, "idle");
  assert.equal(idle.item.messages.at(-1).info.role, "assistant");
  assert.equal(idle.item.messages.at(-1).parts[0].text, "OpenWork worker reply: Summarize the launch notes");
});
