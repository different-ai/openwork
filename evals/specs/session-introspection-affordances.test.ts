import { createServer } from "node:http";
import { afterEach, expect } from "vitest";
import { test } from "@openwork/testkit";

import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import {
  buildOpenworkProviderContributions,
  sessionAffordanceArgsSchemas,
} from "../../apps/server/src/opencode-plugins/openwork-provider-adapters";

// Mirrors the audited inventory: one workspace with far more root sessions
// than the default transcript scan window, the wanted session archived and
// ranked deep by recency, and a long transcript whose first message is out
// of reach for a tail read.
const ROOT_SESSIONS = 240;
const PROBE_RANK = 177;
const LONG_TRANSCRIPT = 300;

type Message = { info: { id: string; role: string; time: { created: number } }; parts: Array<{ type: string; text: string }> };

function transcript(sessionId: string, count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    info: { id: `${sessionId}_msg_${index}`, role: index % 2 === 0 ? "user" : "assistant", time: { created: 1_000_000 + index } },
    parts: [{ type: "text", text: index === 0 ? "Investigate the model and effort introspection gap" : `Turn ${index}` }],
  }));
}

const sessions = Array.from({ length: ROOT_SESSIONS }, (_, index) => {
  const rank = index + 1;
  const probe = rank === PROBE_RANK;
  return {
    id: probe ? "ses_probe" : `ses_${rank}`,
    title: probe ? "variant probe 2 (safe to archive)" : `Routine task ${rank}`,
    directory: "/tmp/openwork",
    time: { created: 5_000_000 - rank * 1000, updated: 9_000_000 - rank * 1000, ...(probe ? { archived: 9_500_000 } : {}) },
  };
});
const transcripts = new Map<string, Message[]>([
  ["ses_1", transcript("ses_1", LONG_TRANSCRIPT)],
  ["ses_probe", transcript("ses_probe", 2)],
]);

const originalEnv = { url: process.env.OPENWORK_SERVER_URL, token: process.env.OPENWORK_SERVER_TOKEN };
let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
  if (originalEnv.url === undefined) delete process.env.OPENWORK_SERVER_URL;
  else process.env.OPENWORK_SERVER_URL = originalEnv.url;
  if (originalEnv.token === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
  else process.env.OPENWORK_SERVER_TOKEN = originalEnv.token;
});

async function startFakeOpenWorkServer() {
  const requests: Array<{ pathname: string; search: string }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ pathname: url.pathname, search: url.search });
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== "Bearer test-token") return json(401, { message: "Unauthorized" });
    if (url.pathname === "/workspaces") return json(200, { items: [{ id: "ws_1", name: "openwork", path: "/tmp/openwork" }] });
    if (url.pathname === "/workspace/ws_1/opencode/session") {
      const limit = Number(url.searchParams.get("limit") ?? ROOT_SESSIONS);
      return json(200, sessions.slice(0, limit));
    }
    const read = /^\/workspace\/ws_1\/opencode\/session\/([^/]+)$/.exec(url.pathname);
    if (read) {
      const session = sessions.find((candidate) => candidate.id === read[1]);
      return session ? json(200, session) : json(404, { message: "Not found" });
    }
    const messages = /^\/workspace\/ws_1\/opencode\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (messages) {
      const all = transcripts.get(messages[1] ?? "") ?? [];
      // Like the engine: `limit` returns the newest window, no limit returns everything.
      const limit = url.searchParams.get("limit");
      return json(200, limit === null ? all : all.slice(-Number(limit)));
    }
    if (url.pathname === "/workspace/ws_1/opencode/session/status") return json(200, {});
    if (url.pathname.endsWith("/children") || url.pathname.endsWith("/permission") || url.pathname.endsWith("/question")) return json(200, []);
    return json(404, { message: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server did not bind a port");
  stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${address.port}`;
  process.env.OPENWORK_SERVER_TOKEN = "test-token";
  return { requests };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The affordance envelope's `result` for a successful query, or a thrown error. */
function resultOf(output: string, id: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || parsed.ok !== true || parsed.id !== id || !isRecord(parsed.result) || parsed.result.ok !== true) {
    throw new Error(`Expected a successful ${id} result: ${output.slice(0, 400)}`);
  }
  return parsed.result;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function ids(result: Record<string, unknown>): string[] {
  return records(result.results).map((entry) => String(entry.sessionId));
}

async function plugin() {
  const instance = await OpenWorkExtensionsPreview();
  return {
    search: async (args: Record<string, unknown>) => resultOf(await instance.tool.openwork_query.execute({ id: "session.search", args }), "session.search"),
    read: async (args: Record<string, unknown>) => resultOf(await instance.tool.openwork_query.execute({ id: "session.read", args }), "session.read"),
  };
}

test("session.search advertises every schema argument so agents can widen a truncated scan", async ({ evidence }) => {
  const contributions = buildOpenworkProviderContributions([]);
  const affordances = contributions.find((contribution) => contribution.featureId === "sessions")?.affordances ?? [];
  const drift: string[] = [];
  for (const [id, schema] of Object.entries(sessionAffordanceArgsSchemas)) {
    const advertised = new Set(affordances.find((affordance) => affordance.id === id)?.arguments.map((argument) => argument.name));
    const accepted = new Set(Object.keys(schema.shape));
    for (const name of accepted) if (!advertised.has(name)) drift.push(`${id}: ${name} accepted but hidden`);
    for (const name of advertised) if (!accepted.has(name)) drift.push(`${id}: ${name} advertised but ignored`);
  }
  const search = affordances.find((affordance) => affordance.id === "session.search");

  expect(drift).toEqual([]);
  expect(search?.arguments.map((argument) => argument.name)).toEqual(expect.arrayContaining(["scanLimit", "limit", "messageLimit", "match", "createdAfter", "createdBefore", "archived"]));
  expect(search?.description).toContain("scanLimit");
  expect(search?.description).toContain("500");
  expect(affordances.find((affordance) => affordance.id === "session.create")?.arguments.map((argument) => argument.name)).toContain("workspaceId");
  evidence.recordAssertionEvidence(
    "Session affordance descriptors match their zod schemas in both directions",
    `No drift across ${Object.keys(sessionAffordanceArgsSchemas).join(", ")}; session.search names scanLimit (max 500) as the truncated-retry knob.`,
    drift.length === 0,
  );
});

test("session.search finds a session by title far beyond the default scan window and reports the window honestly", async ({ evidence }) => {
  const fake = await startFakeOpenWorkServer();
  const { search } = await plugin();

  const byDefault = await search({ query: "variant probe" });
  const widened = await search({ query: "variant probe", scanLimit: 500 });
  const transcriptReads = fake.requests.filter((request) => /\/message$/.test(request.pathname));

  // Default window: 100 of 240 transcripts scanned, yet the archived probe at rank 177 is a title hit.
  expect(byDefault).toMatchObject({ match: "all", totalCandidateSessions: ROOT_SESSIONS, scannedSessions: 100, scanLimit: 100, truncated: true });
  expect(records(byDefault.results)).toEqual([
    expect.objectContaining({ sessionId: "ses_probe", kind: "title", phrase: true, archived: true, parentId: null, createdAt: 5_000_000 - PROBE_RANK * 1000 }),
  ]);
  // Widened window: every transcript scanned, no truncation, same answer.
  expect(widened).toMatchObject({ totalCandidateSessions: ROOT_SESSIONS, scannedSessions: ROOT_SESSIONS, scanLimit: 500, truncated: false });
  expect(ids(widened)).toEqual(["ses_probe"]);
  // Title matching never cost a transcript read for sessions outside the window.
  expect(transcriptReads.filter((request) => request.pathname.includes("ses_probe")).length).toBe(1);
  expect(fake.requests.some((request) => request.pathname === "/workspace/ws_1/opencode/session" && request.search === "?roots=true&limit=100")).toBe(false);
  evidence.recordAssertionEvidence(
    "Title phase covers every root session; scanLimit only bounds transcripts",
    `Default search scanned 100/${ROOT_SESSIONS} transcripts (truncated: true) and still returned the archived probe at rank ${PROBE_RANK} by title; scanLimit 500 scanned ${ROOT_SESSIONS}/${ROOT_SESSIONS} (truncated: false) with the same single hit.`,
    ids(byDefault).length === 1 && ids(widened).length === 1,
  );
});

test("session.search match, time and archived filters narrow results instead of OR-ing terms", async ({ evidence }) => {
  await startFakeOpenWorkServer();
  const { search } = await plugin();
  const found = async (args: Record<string, unknown>) => ids(await search(args));

  // "probe" is only in the probe title; "introspection" only in ses_1's first message.
  expect(await found({ query: "probe introspection" })).toEqual([]);
  expect(await found({ query: "probe introspection", match: "any" })).toEqual(["ses_probe", "ses_1"]);
  expect(await found({ query: "introspection gap", match: "phrase" })).toEqual(["ses_1"]);
  expect(await found({ query: "gap introspection", match: "phrase" })).toEqual([]);
  expect(await found({ query: "variant probe", archived: "exclude" })).toEqual([]);
  expect(await found({ query: "variant probe", archived: "only" })).toEqual(["ses_probe"]);
  expect(await found({ query: "variant probe", createdAfter: 5_000_000 - PROBE_RANK * 1000 })).toEqual(["ses_probe"]);
  expect(await found({ query: "variant probe", createdAfter: 5_000_000 - PROBE_RANK * 1000 + 1 })).toEqual([]);
  expect(await found({ query: "variant probe", createdBefore: new Date(5_000_000 - PROBE_RANK * 1000).toISOString() })).toEqual(["ses_probe"]);
  evidence.recordAssertionEvidence(
    "match defaults to all; any, phrase, archived and created bounds behave as documented",
    `Two-term query returned nothing under all, both sessions under any; phrase respected order; archived exclude/only and createdAfter/createdBefore (epoch and ISO) selected the probe exactly.`,
    true,
  );
});

test("session.read reads from the start of a long transcript and summarizes asked/concluded in one call", async ({ evidence }) => {
  const fake = await startFakeOpenWorkServer();
  const { read } = await plugin();

  const tail = await read({ sessionId: "ses_1", count: 2 });
  const head = await read({ sessionId: "ses_1", count: 2, from: "start" });
  const summary = await read({ sessionId: "ses_1", summary: true });
  const probe = await read({ sessionId: "ses_probe", summary: true });

  expect(tail).toMatchObject({ from: "end", returned: 2, createdAt: 5_000_000 - 1000, archived: false, parentId: null });
  expect(records(tail.messages).map((entry) => entry.id)).toEqual([`ses_1_msg_${LONG_TRANSCRIPT - 2}`, `ses_1_msg_${LONG_TRANSCRIPT - 1}`]);
  expect(head).toMatchObject({ from: "start", returned: 2 });
  expect(records(head.messages).map((entry) => [entry.id, entry.createdAt])).toEqual([["ses_1_msg_0", 1_000_000], ["ses_1_msg_1", 1_000_001]]);
  expect(summary).toMatchObject({
    totalMessages: LONG_TRANSCRIPT,
    firstUser: expect.objectContaining({ id: "ses_1_msg_0", role: "user", text: "Investigate the model and effort introspection gap" }),
    lastAssistant: expect.objectContaining({ id: `ses_1_msg_${LONG_TRANSCRIPT - 1}`, role: "assistant" }),
  });
  expect(summary.messages).toBeUndefined();
  expect(probe).toMatchObject({ archived: true, totalMessages: 2 });
  // The tail read asked the engine for a window; start and summary loaded the whole transcript.
  expect(fake.requests.filter((request) => request.pathname === "/workspace/ws_1/opencode/session/ses_1/message").map((request) => request.search)).toEqual(["?limit=2", "", ""]);
  evidence.recordAssertionEvidence(
    "from=start reaches the true first message; summary returns first user + last assistant only",
    `On a ${LONG_TRANSCRIPT}-message session, count 2 from end returned the last two, from start returned msg_0 and msg_1, and summary returned firstUser=msg_0 / lastAssistant=msg_${LONG_TRANSCRIPT - 1} with no messages array.`,
    records(head.messages)[0]?.id === "ses_1_msg_0" && isRecord(summary.firstUser) && summary.firstUser.id === "ses_1_msg_0",
  );
});
