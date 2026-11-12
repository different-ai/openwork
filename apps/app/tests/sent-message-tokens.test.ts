import { describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

import { mapV2UserPart, v2AcknowledgementText, v2PromptText } from "../src/app/lib/opencode-v2-adapter";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { composerPillPromptParts, splitComposerPillText, type ComposerPill } from "../src/react-app/domains/session/surface/composer/composer-pills";
import {
  composerDraftFromSentParts,
  decodeSentWords,
  sentTextPartToken,
} from "../src/react-app/domains/session/surface/composer/sent-message-tokens";

type PromptPart = Parameters<typeof v2PromptText>[0][number];

const meetingSkill: ComposerPill = {
  kind: "connect-skill",
  slug: "meeting-analysis",
  name: "Meeting analysis",
  marketplace: "OpenWork",
  capability: "skill:meeting-analysis",
};
const session: ComposerPill = { kind: "session", workspaceId: "ws_1", sessionId: "ses_abc123", title: "Q3 plan" };

const text = (value: string): PromptPart => ({ type: "text", text: value });
const fileMention = (path: string, absolute: string): PromptPart => ({
  type: "file", mime: "text/plain", url: `file://${absolute}`, filename: path.split("/").pop(),
  source: { type: "file", path: absolute, text: { value: `@${path}`, start: 0, end: path.length + 1 } },
});

/** What a v2 engine stores for this send, read back as the transcript reads it. */
function reload(parts: PromptPart[]): UIMessage {
  const stored: Part = { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: v2PromptText(parts) };
  const [message] = snapshotToUIMessages({
    messages: [{ info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } }, parts: mapV2UserPart(stored) }],
  } as unknown as Parameters<typeof snapshotToUIMessages>[0]);
  if (!message) throw new Error("no message");
  return message;
}

/** The chips and words the bubble draws, in order. */
function shown(message: UIMessage) {
  return message.parts.flatMap((part) => {
    if (part.type !== "text") return [];
    const token = sentTextPartToken(part);
    if (!token) return splitComposerPillText(part.text).map((segment) => typeof segment === "string" ? segment : { kind: "pill", pill: segment });
    return [token.kind === "pasted" ? { kind: "pasted", text: part.text } : token];
  });
}

describe("a sent turn keeps its chips after reload (one-string engines)", () => {
  test("a Connect skill stays a skill chip, not /slug text (Guillaume's report)", () => {
    const message = reload([...composerPillPromptParts(meetingSkill), text(" today's meeting")]);
    expect(shown(message)).toEqual([{ kind: "pill", pill: meetingSkill }, " today's meeting"]);
  });

  test("a local skill, connector, computer and task reference each come back as their chip", () => {
    const pills: ComposerPill[] = [
      { kind: "skill", name: "meeting-analysis" },
      { kind: "connector", name: "GitHub" },
      { kind: "computer", target: "cloud" },
      session,
    ];
    const parts = pills.flatMap((pill, index) => [...composerPillPromptParts(pill), text(` w${index} `)]);
    expect(shown(reload(parts))).toEqual(pills.flatMap((pill, index) => [{ kind: "pill", pill }, ` w${index} `]));
  });

  test("agent and file mentions reach the model and come back as their chips", () => {
    const parts: PromptPart[] = [{ type: "agent", name: "explore" }, text(" look at "), fileMention("src/app.ts", "/repo/src/app.ts")];
    const prompt = v2PromptText(parts);
    expect(prompt.startsWith("@explore look at @/repo/src/app.ts")).toBe(true);
    expect(prompt).toContain("subagent: explore");
    expect(shown(reload(parts))).toEqual([{ kind: "agent", name: "explore" }, " look at ", { kind: "file", path: "/repo/src/app.ts" }]);
  });

  test("two Connect skills keep their order and an unrelated /word stays text", () => {
    const other: ComposerPill = { ...meetingSkill, slug: "weekly-digest", name: "Weekly digest", capability: "skill:weekly-digest" };
    const parts = [text("see /tmp then "), ...composerPillPromptParts(meetingSkill), text(" and "), ...composerPillPromptParts(other)];
    expect(shown(reload(parts))).toEqual(["see /tmp then ", { kind: "pill", pill: meetingSkill }, " and ", { kind: "pill", pill: other }]);
  });

  test("an instruction whose visible text is gone leaves readable text", () => {
    const [, instruction] = composerPillPromptParts(meetingSkill);
    expect(decodeSentWords("today's meeting", instruction.text)).toEqual(["today's meeting"]);
  });

  test("optimistic and stored turns still correlate", () => {
    const parts: PromptPart[] = [{ type: "agent", name: "explore" }, ...composerPillPromptParts(meetingSkill), text(" now"), fileMention("a.md", "/r/a.md")];
    expect(v2AcknowledgementText(reload(parts).parts as PromptPart[])).toBe(v2AcknowledgementText(parts));
  });
});

describe("Edit puts the same chips back in the composer", () => {
  test("pills, mentions and pasted text become draft tokens", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "/meeting-analysis", providerMetadata: { opencode: { composerPill: meetingSkill } } },
      { type: "text", text: " for " },
      { type: "text", text: "@cloud", providerMetadata: { opencode: { composerPill: { kind: "computer", target: "cloud" } } } },
      { type: "text", text: " with " },
      { type: "text", text: "@explore", providerMetadata: { opencode: { agentMention: "explore" } } },
      { type: "text", text: "@docs/a b.md", providerMetadata: { opencode: { fileMention: "docs/a b.md" } } },
      { type: "text", text: "line 1\nline 2", providerMetadata: { opencode: { pastedText: true } } },
      { type: "text", text: " and [skill notes]" },
    ];
    const draft = composerDraftFromSentParts(parts);
    expect(draft.mentions).toEqual({ cloud: "computer", explore: "agent", "docs/a b.md": "file" });
    expect(draft.pasteParts).toHaveLength(1);
    expect(draft.text).toBe(
      "[connect-skill meeting-analysis|Meeting analysis|OpenWork|skill:meeting-analysis] for @cloud with @explore@docs/a%20b.md"
        + `[pasted text ${draft.pasteParts[0]?.label}] and [skill notes]`,
    );
  });

  test("a turn reloaded from a one-string engine edits back to the same tokens", () => {
    const draft = composerDraftFromSentParts(reload([...composerPillPromptParts(meetingSkill), text(" today's meeting")]).parts);
    expect(draft.text).toBe("[connect-skill meeting-analysis|Meeting analysis|OpenWork|skill:meeting-analysis] today's meeting");
  });
});
