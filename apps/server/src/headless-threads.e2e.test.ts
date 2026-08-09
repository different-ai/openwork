import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHeadlessThreadClient } from "@openwork/headless-threads";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const SESSION_ID = "ses_headless";
const FIRST_ANSWER = "The refund window closed after 30 days.";
const SECOND_ANSWER = "Without a receipt, use the order lookup.";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function message(id: string, role: string, text: string) {
  return {
    info: { id, sessionID: SESSION_ID, role, time: { created: 100 } },
    parts: [{ id: `prt_${id}`, messageID: id, sessionID: SESSION_ID, type: "text", text }],
  };
}

const USER_1 = message("msg_1", "user", "A customer wants a refund after 40 days.");
const ASSISTANT_1 = message("msg_2", "assistant", FIRST_ANSWER);
const USER_2 = message("msg_3", "user", "They also lost the receipt.");
const ASSISTANT_2 = message("msg_4", "assistant", SECOND_ANSWER);

/**
 * What the engine looks like at each step of two turns. Beat 0 and beat 3 are
 * the moments that matter: the thread has accepted a prompt but has not
 * started, so it reads idle with no new reply. A client that settles there
 * reports a turn finished before it began.
 */
const BEATS = [
  { busy: false, messages: [USER_1] },
  { busy: true, messages: [USER_1] },
  { busy: false, messages: [USER_1, ASSISTANT_1] },
  { busy: false, messages: [USER_1, ASSISTANT_1, USER_2] },
  { busy: true, messages: [USER_1, ASSISTANT_1, USER_2] },
  { busy: false, messages: [USER_1, ASSISTANT_1, USER_2, ASSISTANT_2] },
];

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-headless-threads-"));
  await mkdir(join(root, ".opencode"), { recursive: true });
  roots.push(root);
  return root;
}

/**
 * A managed-OpenCode stand-in. It only moves to the next beat when `advance()`
 * is called, which the test wires to the client's sleep — so the whole journey
 * is deterministic and needs no wall-clock waiting.
 */
function startMockOpencode() {
  const prompts: Array<Record<string, unknown>> = [];
  let aborted = 0;
  let beat = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const current = BEATS[Math.min(beat, BEATS.length - 1)];
      const session = {
        id: SESSION_ID,
        title: "Refund policy",
        slug: "refund-policy",
        directory: request.headers.get("x-opencode-directory"),
        time: { created: 100, updated: 100 },
      };

      if (url.pathname === "/session" && request.method === "POST") return Response.json(session);
      if (url.pathname === "/session" && request.method === "GET") return Response.json([session]);
      if (url.pathname === `/session/${SESSION_ID}`) return Response.json(session);
      if (url.pathname === `/session/${SESSION_ID}/message`) return Response.json(current.messages);
      if (url.pathname === `/session/${SESSION_ID}/todo`) return Response.json([]);
      if (url.pathname === "/session/status") {
        return Response.json(current.busy ? { [SESSION_ID]: { type: "busy" } } : {});
      }
      if (url.pathname === `/session/${SESSION_ID}/prompt_async` && request.method === "POST") {
        prompts.push(await request.json());
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/session/${SESSION_ID}/abort` && request.method === "POST") {
        aborted += 1;
        return Response.json(true);
      }
      return Response.json({ code: "not_found", message: `Not found: ${request.method} ${url.pathname}` }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));

  return {
    server,
    prompts,
    advance: () => {
      beat += 1;
    },
    abortCount: () => aborted,
  };
}

async function startOpenworkServer(input: { workspaceRoot: string; opencodeBaseUrl: string }) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: input.workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: input.opencodeBaseUrl,
      },
    ],
    authorizedRoots: [input.workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, token: config.token };
}

test("drives two headless turns on a native OpenWork thread", async () => {
  const workspaceRoot = await createWorkspaceRoot();
  const engine = startMockOpencode();
  const openwork = await startOpenworkServer({
    workspaceRoot,
    opencodeBaseUrl: `http://127.0.0.1:${engine.server.port}`,
  });

  let clock = 0;
  const threads = createHeadlessThreadClient({
    baseUrl: `http://127.0.0.1:${openwork.server.port}`,
    workspaceId: "ws_1",
    token: openwork.token,
    defaultModel: { providerId: "anthropic", modelId: "claude-sonnet-5" },
    now: () => clock,
    // Each poll gap moves the engine exactly one beat, so the journey below is
    // reproducible and never waits on real time.
    sleep: async (ms) => {
      clock += ms;
      engine.advance();
    },
  });

  const thread = await threads.createThread({
    title: "Refund policy",
    prompt: "A customer wants a refund after 40 days.",
  });

  expect(thread.id).toBe(SESSION_ID);
  expect(thread.started).toBe(true);
  expect(thread.directory).toBe(workspaceRoot);
  expect(engine.prompts).toHaveLength(1);
  expect(engine.prompts[0]).toEqual({
    parts: [{ type: "text", text: "A customer wants a refund after 40 days." }],
    model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
  });

  const firstWait = await threads.waitForThread(thread.id, { timeoutMs: 60_000, pollIntervalMs: 10 });

  expect(firstWait.outcome).toBe("settled");
  expect(firstWait.observedRunning).toBe(true);
  // Beat 0 was idle with no reply yet: settling there would have been wrong.
  expect(firstWait.polls).toBe(3);

  const firstTranscript = await threads.exportTranscript(thread.id);
  expect(firstTranscript.finalAssistantText).toBe(FIRST_ANSWER);
  expect(firstTranscript.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);

  const followUp = await threads.sendTurn(thread.id, { prompt: "They also lost the receipt." });

  expect(followUp.messageCountBefore).toBe(2);
  expect(engine.prompts).toHaveLength(2);
  expect(engine.prompts[1]).toEqual({
    parts: [{ type: "text", text: "They also lost the receipt." }],
    model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
  });

  const secondWait = await threads.waitForThread(thread.id, {
    timeoutMs: 60_000,
    pollIntervalMs: 10,
    since: followUp,
  });

  expect(secondWait.outcome).toBe("settled");
  expect(secondWait.observedRunning).toBe(true);
  // The first answer was already in the thread; only the new one settles it.
  expect(secondWait.polls).toBe(4);

  const transcript = await threads.exportTranscript(thread.id);
  expect(transcript.finalAssistantText).toBe(SECOND_ANSWER);
  expect(transcript.messages.map((entry) => entry.text)).toEqual([
    "A customer wants a refund after 40 days.",
    FIRST_ANSWER,
    "They also lost the receipt.",
    SECOND_ANSWER,
  ]);

  await expect(threads.abortThread(thread.id)).resolves.toEqual({ threadId: thread.id, accepted: true });
  expect(engine.abortCount()).toBe(1);
});

test("leaves the thread readable through the session surface the app uses", async () => {
  const workspaceRoot = await createWorkspaceRoot();
  const engine = startMockOpencode();
  const openwork = await startOpenworkServer({
    workspaceRoot,
    opencodeBaseUrl: `http://127.0.0.1:${engine.server.port}`,
  });
  const base = `http://127.0.0.1:${openwork.server.port}`;

  const thread = await createHeadlessThreadClient({
    baseUrl: base,
    workspaceId: "ws_1",
    token: openwork.token,
  }).createThread({ title: "Refund policy" });

  // The app lists and opens sessions through these routes. A headless thread
  // is an ordinary session, so it has to be visible here with the same id.
  const listed = await fetch(`${base}/workspace/ws_1/sessions`, {
    headers: { Authorization: `Bearer ${openwork.token}` },
  });
  expect(listed.status).toBe(200);
  const listedBody = await listed.json();
  expect(listedBody.items.map((item: { id: string }) => item.id)).toContain(thread.id);

  const opened = await fetch(`${base}/workspace/ws_1/sessions/${thread.id}`, {
    headers: { Authorization: `Bearer ${openwork.token}` },
  });
  expect(opened.status).toBe(200);
  await expect(opened.json()).resolves.toMatchObject({ item: { id: thread.id, title: "Refund policy" } });
});
