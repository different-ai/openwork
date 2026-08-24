import { describe, expect, test } from "bun:test";

import type { SessionSnapshotReadModel } from "./session-read-model.js";
import {
  buildSessionExportBundle,
  extractMessageText,
  parseSessionExportBundle,
  planSessionImport,
  redactSecretsInText,
  renderSessionBundleMarkdown,
  SESSION_EXPORT_FORMAT,
  SESSION_EXPORT_VERSION,
  SessionBundleError,
} from "./session-transfer.js";

function textPart(sessionId: string, messageId: string, partId: string, text: string) {
  return { id: partId, messageID: messageId, sessionID: sessionId, type: "text", text };
}

function snapshot(input: {
  sessionId: string;
  title?: string;
  messages: Array<{ id: string; role: string; text: string; created?: number }>;
  todos?: Array<{ content: string; status: string; priority: string }>;
}): SessionSnapshotReadModel {
  return {
    session: {
      id: input.sessionId,
      title: input.title ?? "Untitled",
      time: { created: 1_700_000_000_000 },
    },
    messages: input.messages.map((message) => ({
      info: {
        id: message.id,
        sessionID: input.sessionId,
        role: message.role,
        time: { created: message.created ?? 1_700_000_000_000 },
      },
      parts: [textPart(input.sessionId, message.id, `prt_${message.id}`, message.text)],
    })),
    todos: input.todos ?? [],
    status: { type: "idle" },
  };
}

describe("redactSecretsInText", () => {
  test("replaces high-confidence secret values and reports signals", () => {
    const result = redactSecretsInText(
      "run with Authorization: Bearer abcdef1234567890 and api_key = \"sk_live_0123456789abcdef\"",
    );

    expect(result.text).not.toContain("abcdef1234567890");
    expect(result.text).not.toContain("sk_live_0123456789abcdef");
    expect(result.text).toContain("[redacted]");
    expect(result.signals.length).toBeGreaterThan(0);
  });

  test("keeps ordinary prose that merely mentions a secret word", () => {
    const result = redactSecretsInText("I forgot my password, can you help me reset it?");

    expect(result.text).toBe("I forgot my password, can you help me reset it?");
    expect(result.signals).toEqual([]);
  });

  test("redacts a PEM private key block", () => {
    const result = redactSecretsInText(
      "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\ndone",
    );

    expect(result.text).not.toContain("MIIEow==");
    expect(result.signals).toContain("privateKey");
  });
});

describe("buildSessionExportBundle", () => {
  test("wraps a single session in the versioned envelope", () => {
    const { bundle, warnings } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "auto",
      exportedAt: new Date("2026-01-01T00:00:00.000Z"),
      snapshots: [snapshot({ sessionId: "ses_1", title: "Plan the launch", messages: [{ id: "msg_1", role: "user", text: "hello" }] })],
    });

    expect(bundle.format).toBe(SESSION_EXPORT_FORMAT);
    expect(bundle.version).toBe(SESSION_EXPORT_VERSION);
    expect(bundle.workspaceId).toBe("ws_1");
    expect(bundle.exportedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions[0]?.session.id).toBe("ses_1");
    expect(warnings).toEqual([]);
  });

  test("carries every session of a workspace in the same envelope", () => {
    const { bundle } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [
        snapshot({ sessionId: "ses_1", messages: [{ id: "msg_1", role: "user", text: "one" }] }),
        snapshot({ sessionId: "ses_2", messages: [{ id: "msg_2", role: "user", text: "two" }] }),
      ],
    });

    expect(bundle.sessions.map((entry) => entry.session.id)).toEqual(["ses_1", "ses_2"]);
  });

  test("redacts secrets and warns when sensitive content is present", () => {
    const { bundle, warnings } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [
        snapshot({
          sessionId: "ses_1",
          title: "Deploy",
          messages: [{ id: "msg_1", role: "assistant", text: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123" }],
        }),
      ],
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(serialized).toContain("[redacted]");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.id).toBe("session:ses_1");
    expect(warnings[0]?.label).toBe("Deploy");
  });

  test("preserves the original transcript when the caller opts in", () => {
    const { bundle, warnings } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "include",
      snapshots: [
        snapshot({
          sessionId: "ses_1",
          messages: [{ id: "msg_1", role: "assistant", text: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123" }],
        }),
      ],
    });

    expect(JSON.stringify(bundle)).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(warnings).toHaveLength(1);
  });
});

describe("extractMessageText", () => {
  test("joins text parts and names tool calls", () => {
    const text = extractMessageText({
      info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
      parts: [
        textPart("ses_1", "msg_1", "prt_1", "Looking into it"),
        { id: "prt_2", messageID: "msg_1", sessionID: "ses_1", type: "tool", tool: "bash" },
        textPart("ses_1", "msg_1", "prt_3", "Done"),
      ],
    });

    expect(text).toBe("Looking into it\n\n[tool: bash]\n\nDone");
  });
});

describe("renderSessionBundleMarkdown", () => {
  test("renders a readable single-session transcript", () => {
    const { bundle } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      exportedAt: new Date("2026-01-01T00:00:00.000Z"),
      snapshots: [
        snapshot({
          sessionId: "ses_1",
          title: "Plan the launch",
          messages: [
            { id: "msg_1", role: "user", text: "What is left?" },
            { id: "msg_2", role: "assistant", text: "Two items." },
          ],
          todos: [{ content: "Ship docs", status: "completed", priority: "high" }],
        }),
      ],
    });

    const markdown = renderSessionBundleMarkdown(bundle);

    expect(markdown).toContain("# Plan the launch");
    expect(markdown).toContain("`ses_1`");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("What is left?");
    expect(markdown).toContain("## Assistant");
    expect(markdown).toContain("Two items.");
    expect(markdown).toContain("- [x] Ship docs");
  });

  test("renders one section per session for a workspace export", () => {
    const { bundle } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [
        snapshot({ sessionId: "ses_1", title: "First", messages: [{ id: "msg_1", role: "user", text: "one" }] }),
        snapshot({ sessionId: "ses_2", title: "Second", messages: [{ id: "msg_2", role: "user", text: "two" }] }),
      ],
    });

    const markdown = renderSessionBundleMarkdown(bundle);

    expect(markdown).toContain("# Session export (2 sessions)");
    expect(markdown).toContain("## First");
    expect(markdown).toContain("## Second");
  });
});

describe("parseSessionExportBundle", () => {
  function validBundle() {
    return buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [snapshot({ sessionId: "ses_1", messages: [{ id: "msg_1", role: "user", text: "hello" }] })],
    }).bundle;
  }

  test("accepts a bundle produced by export", () => {
    const parsed = parseSessionExportBundle(JSON.parse(JSON.stringify(validBundle())));
    expect(parsed.sessions[0]?.session.id).toBe("ses_1");
  });

  test("rejects a file that is not a session bundle", () => {
    expect(() => parseSessionExportBundle({ hello: "world" })).toThrow(SessionBundleError);
  });

  test("rejects a bundle from a newer format version", () => {
    expect(() => parseSessionExportBundle({ ...validBundle(), version: SESSION_EXPORT_VERSION + 1 })).toThrow(
      /newer than this app supports/,
    );
  });

  test("rejects an empty bundle", () => {
    expect(() => parseSessionExportBundle({ ...validBundle(), sessions: [] })).toThrow(/no sessions/);
  });
});

describe("planSessionImport", () => {
  test("carries messages across with their original parts intact", () => {
    const { bundle } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [
        snapshot({
          sessionId: "ses_1",
          title: "Plan the launch",
          messages: [
            { id: "msg_1", role: "user", text: "What is left?" },
            { id: "msg_2", role: "assistant", text: "Two items." },
          ],
        }),
      ],
    });

    const planned = planSessionImport(bundle);

    expect(planned).toHaveLength(1);
    expect(planned[0]?.title).toBe("Plan the launch");
    expect(planned[0]?.sourceSessionId).toBe("ses_1");
    expect(planned[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(planned[0]?.messages[0]?.parts).toEqual([{ type: "text", text: "What is left?" }]);
    expect(planned[0]?.messages[0]?.sourceId).toBe("msg_1");
  });

  test("keeps reasoning a separate part instead of folding it into the reply", () => {
    const { bundle } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [
        {
          session: { id: "ses_1", title: "Reasoned" },
          messages: [
            {
              info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
              parts: [
                { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "reasoning", text: "Thinking it through" },
                { id: "prt_2", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "Here is the answer" },
              ],
            },
          ],
          todos: [],
          status: { type: "idle" },
        },
      ],
    });

    const parts = planSessionImport(bundle)[0]?.messages[0]?.parts;

    expect(parts).toEqual([
      { type: "reasoning", text: "Thinking it through" },
      { type: "text", text: "Here is the answer" },
    ]);
  });

  test("drops parts that describe a live run rather than the conversation", () => {
    const { bundle } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [
        {
          session: { id: "ses_1", title: "Noisy" },
          messages: [
            {
              info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
              parts: [
                { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "step-start" },
                { id: "prt_2", messageID: "msg_1", sessionID: "ses_1", type: "snapshot", snapshot: "abc" },
                { id: "prt_3", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "Done" },
              ],
            },
          ],
          todos: [],
          status: { type: "idle" },
        },
      ],
    });

    expect(planSessionImport(bundle)[0]?.messages[0]?.parts).toEqual([{ type: "text", text: "Done" }]);
  });

  test("treats non-user roles as assistant turns", () => {
    const { bundle } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [snapshot({ sessionId: "ses_1", messages: [{ id: "msg_1", role: "system", text: "boot" }] })],
    });

    expect(planSessionImport(bundle)[0]?.messages[0]?.role).toBe("assistant");
  });

  test("rejects a bundle whose sessions carry no replayable parts", () => {
    const { bundle } = buildSessionExportBundle({
      workspaceId: "ws_1",
      sensitiveMode: "exclude",
      snapshots: [
        {
          session: { id: "ses_1", title: "Empty" },
          messages: [
            {
              info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
              parts: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "step-start" }],
            },
          ],
          todos: [],
          status: { type: "idle" },
        },
      ],
    });

    expect(() => planSessionImport(bundle)).toThrow(/no messages to import/);
  });
});
