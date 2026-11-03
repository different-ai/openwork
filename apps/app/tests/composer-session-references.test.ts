import { describe, expect, test } from "bun:test";

import { createSessionReferenceIndex, type SessionReferenceInventory } from "../src/components/chat/session-reference";
import {
  COMPOSER_DRAFT_TOKEN_RE,
  composerPillPromptParts,
  composerPillText,
  parseComposerPillToken,
  readComposerPill,
  splitComposerPillText,
} from "../src/react-app/domains/session/surface/composer/composer-pills";
import { filterSessionReferenceCandidates } from "../src/react-app/domains/session/surface/composer/session-reference-search";
import {
  encodeSessionReferenceToken,
  parseSessionReferenceToken,
} from "../src/react-app/domains/session/surface/composer/session-reference-token";
import { pendingDraftTextParts } from "../src/react-app/domains/session/surface/use-displayed-messages";
import { deriveComposerHistory } from "../src/react-app/domains/session/surface/session-render-state";

const reference = { workspaceId: "ws_1", sessionId: "ses_login", title: "Fix login bug" };

function session(id: string, title: string, updated: number, extra: { archived?: number; parentID?: string } = {}) {
  return { id, title, parentID: extra.parentID, time: { created: updated, updated, archived: extra.archived } };
}

describe("session reference token", () => {
  test("round-trips ids and title", () => {
    const token = encodeSessionReferenceToken(reference);
    expect(token).toBe("[session ws_1 ses_login Fix login bug]");
    expect(parseSessionReferenceToken(token ?? "")).toEqual(reference);
  });

  test("strips characters that would break the token from the title", () => {
    const token = encodeSessionReferenceToken({ ...reference, title: "Plan [draft]\nv2" });
    expect(token).toBe("[session ws_1 ses_login Plan draft v2]");
    expect(parseSessionReferenceToken(token ?? "")?.title).toBe("Plan draft v2");
  });

  test("rejects ids that are not route segments", () => {
    expect(encodeSessionReferenceToken({ ...reference, workspaceId: "../etc" })).toBeNull();
    expect(parseSessionReferenceToken("[session ws_1]")).toBeNull();
    expect(parseSessionReferenceToken("[session a/b ses_1 Title]")).toBeNull();
    expect(parseSessionReferenceToken("[session ws_1 ses?x Title]")).toBeNull();
  });

  test("is one draft segment and never swallows ordinary # text", () => {
    const draft = "# Heading\nsee [session ws_1 ses_login Fix login bug] and #tag";
    const segments = draft.split(COMPOSER_DRAFT_TOKEN_RE).filter(Boolean);
    expect(segments).toEqual(["# Heading\nsee ", "[session ws_1 ses_login Fix login bug]", " and #tag"]);
  });
});

describe("session reference pill", () => {
  const pill = { kind: "session" as const, ...reference };

  test("parses from the draft token", () => {
    expect(parseComposerPillToken("[session ws_1 ses_login Fix login bug]")).toEqual(pill);
  });

  test("sends the task route as text and a hidden session.read instruction", () => {
    const [visible, instruction] = composerPillPromptParts(pill);
    // The route is stable across renames; the transcript renders it with the current title.
    expect(visible.text).toBe("/workspace/ws_1/session/ses_login");
    expect(visible.metadata).toMatchObject({ openworkComposerPill: pill, openworkComposerToken: "[session ws_1 ses_login Fix login bug]" });
    expect(instruction.synthetic).toBe(true);
    expect(instruction.text).toContain('"session.read"');
    expect(instruction.text).toContain("ses_login");
    expect(instruction.text).toContain("not accessible");
    // A summary or a default read is partial; the hint says how to reach earlier messages.
    expect(instruction.text).toContain('"from": "start"');
    expect(instruction.text).toContain("session.search");
  });

  test("validates pills read back from message metadata", () => {
    expect(readComposerPill(pill)).toEqual(pill);
    expect(readComposerPill({ kind: "session", workspaceId: "ws_1" })).toBeNull();
    expect(readComposerPill({ kind: "session", workspaceId: "ws 1", sessionId: "ses_1" })).toBeNull();
  });

  test("a token that reached the transcript as text still renders as the pill", () => {
    expect(splitComposerPillText("about [session ws_1 ses_login Fix login bug]!")).toEqual(["about ", pill, "!"]);
  });

  test("the pending turn shows the pill before the server echoes it", () => {
    const parts = pendingDraftTextParts([{ type: "text", text: "compare " }, { type: "session", ...reference }]);
    expect(parts?.[1]).toMatchObject({ text: composerPillText(pill), providerMetadata: { opencode: { composerPill: pill } } });
  });

  test("prompt history recalls the reference as a chip", () => {
    const history = deriveComposerHistory([{
      id: "msg_1",
      role: "user",
      parts: [
        { type: "text", text: "compare " },
        { type: "text", text: "/workspace/ws_1/session/ses_login", providerMetadata: { opencode: { composerPill: pill, composerToken: "[session ws_1 ses_login Fix login bug]" } } },
      ],
    }]);
    expect(history).toEqual(["compare \n[session ws_1 ses_login Fix login bug]"]);
  });
});

describe("task candidates", () => {
  const inventories: SessionReferenceInventory[] = [
    {
      workspaceId: "ws_1",
      workspaceTitle: "Website",
      available: true,
      sessions: [
        session("ses_login", "Fix login bug", 300),
        session("ses_old", "Login page copy", 100, { archived: 150 }),
        session("ses_child", "Sub-agent: research", 400, { parentID: "ses_login" }),
        session("ses_pricing", "Pricing page", 200),
      ],
    },
    {
      workspaceId: "ws_2",
      workspaceTitle: "Billing",
      available: true,
      sessions: [session("ses_invoice", "Invoice export", 250)],
    },
    // A workspace whose sessions cannot be confirmed is never offered or linked.
    { workspaceId: "ws_private", workspaceTitle: "Private", available: false, sessions: [session("ses_secret", "Secret plan", 999)] },
  ];
  const index = createSessionReferenceIndex(inventories);

  test("lists root tasks from every available workspace, unarchived and newest first", () => {
    expect(index.candidates().map((candidate) => candidate.sessionId)).toEqual(["ses_login", "ses_invoice", "ses_pricing", "ses_old"]);
    expect(index.candidates()[1]).toMatchObject({ workspaceTitle: "Billing", title: "Invoice export", updatedAt: 250 });
  });

  test("never offers or resolves tasks from unavailable workspaces", () => {
    expect(index.candidates().some((candidate) => candidate.workspaceId === "ws_private")).toBe(false);
    expect(index.resolve("/workspace/ws_private/session/ses_secret")).toBeUndefined();
  });

  test("an empty query lists recent tasks, without the task being written in", () => {
    const results = filterSessionReferenceCandidates(index.candidates(), "", { excludeSessionId: "ses_login" });
    expect(results.map((candidate) => candidate.sessionId)).toEqual(["ses_invoice", "ses_pricing", "ses_old"]);
  });

  test("fuzzy matches partial and non-contiguous titles", () => {
    expect(filterSessionReferenceCandidates(index.candidates(), "lgnbug")[0]?.sessionId).toBe("ses_login");
    expect(filterSessionReferenceCandidates(index.candidates(), "invexp")[0]?.sessionId).toBe("ses_invoice");
    expect(filterSessionReferenceCandidates(index.candidates(), "login").map((candidate) => candidate.sessionId)).toEqual(
      expect.arrayContaining(["ses_login", "ses_old"]),
    );
    expect(filterSessionReferenceCandidates(index.candidates(), "zzzz")).toEqual([]);
  });

  test("ranks title matches above folder-name matches", () => {
    const results = filterSessionReferenceCandidates(index.candidates(), "billing");
    expect(results[0]?.sessionId).toBe("ses_invoice");
    const titleFirst = filterSessionReferenceCandidates(index.candidates(), "pricing");
    expect(titleFirst[0]?.sessionId).toBe("ses_pricing");
  });

  test("respects the result limit", () => {
    expect(filterSessionReferenceCandidates(index.candidates(), "", { limit: 2 })).toHaveLength(2);
  });
});
