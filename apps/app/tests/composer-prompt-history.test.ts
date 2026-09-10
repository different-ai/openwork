import { expect, test } from "bun:test";
import type { TextPart } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";
import type { OpenworkSessionMessage, OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import type { ComposerPart } from "../src/app/types";
import { draftToParts } from "../src/react-app/domains/session/sync/draft-parts";
import { textPartToUIPart } from "../src/react-app/domains/session/sync/usechat-adapter";
import { encodeConnectSkillToken, parseConnectSkillToken } from "../src/react-app/domains/session/surface/composer/connect-skill-token";
import { parseSlashCommandInvocation } from "../src/react-app/domains/session/surface/composer/slash-command";
import {
  deriveComposerHistory,
  deriveRenderedSessionMessages,
  resolveRenderedSessionSnapshot,
} from "../src/react-app/domains/session/surface/session-render-state";

function message(id: string, text: string, created = 1): OpenworkSessionMessage {
  return {
    info: {
      id, sessionID: "session-a", role: "user", time: { created },
      agent: "build", model: { providerID: "test", modelID: "test" },
    },
    parts: [{ id: `part-${id}`, sessionID: "session-a", messageID: id, type: "text", text }],
  };
}

function snapshot(messages: OpenworkSessionMessage[]): OpenworkSessionSnapshot {
  return {
    session: {
      id: "session-a", slug: "history", projectID: "project-a", directory: "/fixture",
      title: "History", version: "0", time: { created: 1, updated: 100 },
    },
    messages, todos: [], status: { type: "idle" },
  };
}

function history(stored: OpenworkSessionSnapshot | null, live: UIMessage[] = []) {
  return deriveComposerHistory(deriveRenderedSessionMessages({ snapshot: stored, transcriptState: live }));
}

test("cold recall restores only user-authored text, not synthetic instructions, ignored text, files or assistant output", () => {
  const first = message("first", "  First line");
  first.parts.push(
    { id: "second-line", sessionID: "session-a", messageID: "first", type: "text", text: "Second line  " },
    { id: "synthetic", sessionID: "session-a", messageID: "first", type: "text", text: "PRIVATE INSTRUCTION", synthetic: true },
    { id: "ignored", sessionID: "session-a", messageID: "first", type: "text", text: "IGNORED TEXT", ignored: true },
    { id: "file", sessionID: "session-a", messageID: "first", type: "file", mime: "text/plain", url: "file:///private.txt" },
  );
  const hidden = message("hidden", "HIDDEN ONLY");
  hidden.parts = [{ id: "hidden-part", sessionID: "session-a", messageID: "hidden", type: "text", text: "HIDDEN ONLY", synthetic: true }];
  const stored = snapshot([first, message("blank", " \n "), hidden]);
  const before = structuredClone(stored);
  const recalled = history(stored, [{ id: "assistant", role: "assistant", parts: [{ type: "text", text: "Assistant answer" }] }]);
  expect(recalled).toEqual(["First line\nSecond line"]);
  for (const excluded of ["PRIVATE INSTRUCTION", "IGNORED TEXT", "private.txt", "HIDDEN ONLY", "Assistant answer"]) {
    expect(recalled.join("\n")).not.toContain(excluded);
  }
  expect(stored).toEqual(before);
});

test("recall caps at 50 after trimming and consecutive deduplication, retaining nonconsecutive repetitions", () => {
  const messages = Array.from({ length: 60 }, (_, index) => message(`message-${index}`, `Prompt ${index}`, index));
  messages.push(message("repeat-last", " Prompt 59 ", 60), message("repeat-earlier", "Prompt 58", 61));
  const recalled = history(snapshot(messages));
  expect(recalled).toEqual([...Array.from({ length: 49 }, (_, index) => `Prompt ${index + 11}`), "Prompt 58"]);
  expect(recalled).toHaveLength(50);
  expect(recalled).not.toContain("Prompt 10");
  expect(recalled.filter((text) => text === "Prompt 59")).toHaveLength(1);
  expect(recalled.filter((text) => text === "Prompt 58")).toHaveLength(2);
});

test("an older fetch cannot clobber a new live send and repeated snapshots do not duplicate acknowledged prompts", () => {
  const stored = snapshot([message("one", "Repeated prompt", 1), message("two", "Other prompt", 2)]);
  const live: UIMessage[] = [{ id: "three", role: "user", metadata: { opencode: { created: 3 } }, parts: [{ type: "text", text: "Repeated prompt" }] }];
  const expected = ["Repeated prompt", "Other prompt", "Repeated prompt"];
  expect(history(null, live)).toEqual(["Repeated prompt"]);
  expect(history(stored, live)).toEqual(expected);
  const acknowledged = snapshot([...stored.messages, message("three", "Repeated prompt", 3)]);
  for (let fetch = 0; fetch < 3; fetch += 1) {
    expect(history(structuredClone(acknowledged), live)).toEqual(expected);
  }
  expect(history(stored, live)).not.toEqual(["Repeated prompt", "Other prompt"]);
  expect(history(acknowledged, live)).toHaveLength(3);
  expect(stored.messages).toHaveLength(2);
  expect(live).toHaveLength(1);
});

test("switching sessions never recalls the previous session's cached snapshot", () => {
  const stored = snapshot([message("private", "Private prompt")]);
  const selected = resolveRenderedSessionSnapshot({
    sessionId: "session-b", currentSnapshot: stored,
    cachedRendered: { sessionId: "session-a", snapshot: stored },
  });
  expect(selected).toBeNull();
  expect(history(selected)).toEqual([]);
  expect(history(selected)).not.toContain("Private prompt");
  expect(history(stored)).toEqual(["Private prompt"]);
});

test("reverted messages and removed pending sends do not linger in a second history store", () => {
  const stored = snapshot([message("one", "Keep", 1), message("two", "Reverted", 2)]);
  stored.session.revert = { messageID: "two" };
  expect(history(stored)).toEqual(["Keep"]);
  expect(history(stored)).not.toContain("Reverted");
  const pending: UIMessage[] = [{ id: "pending", role: "user", parts: [{ type: "text", text: "Submitted" }] }];
  expect(deriveComposerHistory(pending)).toEqual(["Submitted"]);
  expect(deriveComposerHistory([])).toEqual([]);
  expect(deriveComposerHistory([])).not.toContain("Submitted");
});

test("Connect skill identity round-trips through durable text-part metadata in both draft branches, without changing display or model instructions", async () => {
  const skill = {
    type: "connect-skill", slug: "compact", name: "Com|pact ] %",
    marketplace: "Team tools", capability: "plugin:team:compact",
  } satisfies ComposerPart;
  const token = encodeConnectSkillToken(skill);
  for (const prefix of ["", "Please use "]) {
    for (const attachmentToken of ["", "[attachment removed]"]) {
      const parts = await draftToParts({
        mode: "prompt", text: `${prefix}${token} Keep the details.${attachmentToken}`,
        parts: [...(prefix ? [{ type: "text", text: prefix } satisfies ComposerPart] : []), skill, { type: "text", text: " Keep the details." }],
        attachments: [],
      }, "/fixture", "session-a", null);
      const stored = message("connected", "");
      stored.parts = parts.map((part, index) => ({ ...part, id: `part-${index}`, sessionID: "session-a", messageID: stored.info.id }));
      const before = structuredClone(stored);
      const expected = [prefix, token, " Keep the details."].filter(Boolean).join("\n").trim();
      const rendered = deriveRenderedSessionMessages({ snapshot: snapshot([stored]), transcriptState: [] });
      expect(history(snapshot(structuredClone([stored])))).toEqual([expected]);
      expect(rendered[0]?.parts.filter((part) => part.type === "text").map((part) => part.text).join(""))
        .toBe(`${prefix}/compact Keep the details.`);
      const liveParts = stored.parts.flatMap((part) => {
        if (part.type !== "text") return [];
        const mapped = textPartToUIPart(part);
        return mapped ? [mapped] : [];
      });
      const live: UIMessage[] = [{ id: stored.info.id, role: "user", parts: liveParts }];
      expect(history(null, live)).toEqual([expected]);
      expect(history(snapshot([stored]), live)).toEqual([expected]);
      expect(parseSlashCommandInvocation(expected)).toBeNull();
      expect(expected).not.toContain("execute_capability");
      const recalledToken = expected.match(/\[connect-skill [^\]]+\]/)?.[0] ?? "";
      const identity = parseConnectSkillToken(recalledToken);
      expect(identity).toEqual({ slug: skill.slug, name: skill.name, marketplace: skill.marketplace, capability: skill.capability });
      if (!identity) throw new Error("Missing recalled skill identity");
      const resent = await draftToParts({ mode: "prompt", text: recalledToken, parts: [{ type: "connect-skill", ...identity }], attachments: [] }, "/fixture", "session-a", null);
      expect(resent.filter((part) => part.type === "text" && part.synthetic))
        .toEqual(parts.filter((part) => part.type === "text" && part.synthetic));
      expect(stored).toEqual(before);
    }
  }
});

test("legacy slash labels and native commands are excluded rather than replayed with lost identity", () => {
  const legacy = message("legacy", "/compact");
  legacy.parts.push(
    { id: "instructions", messageID: legacy.info.id, sessionID: "session-a", type: "text", synthetic: true, text: "PRIVATE Connect skill instructions with plugin:team:compact" },
    { id: "suffix", messageID: legacy.info.id, sessionID: "session-a", type: "text", text: " Keep the details." },
  );
  expect(history(snapshot([legacy]))).toEqual([]);
  const inline = structuredClone(legacy);
  inline.parts.unshift({ id: "prefix", messageID: legacy.info.id, sessionID: "session-a", type: "text", text: "Please use " });
  expect(history(snapshot([inline]))).toEqual([]);
  for (const text of [" /compact Keep the details.", "/compact\nKeep the details."]) {
    expect(history(null, [{ id: "pending", role: "user", parts: [{ type: "text", text }] }])).toEqual([]);
  }
  expect(history(snapshot([message("command", "/compact"), message("path", "/workspace/notes.txt"), message("local", "[skill summarize] Keep the details.")])))
    .toEqual(["/workspace/notes.txt", "[skill summarize] Keep the details."]);
});

test("invalid or mismatched token metadata cannot turn a label into a recalled skill; hidden metadata stays hidden", () => {
  const token = encodeConnectSkillToken({ slug: "compact", name: "Compact", marketplace: "Team", capability: "skill:compact" });
  for (const metadata of [{ openworkComposerToken: "[connect-skill incomplete]" }, { openworkComposerToken: token }, { openworkComposerToken: 42 }]) {
    const stored = message("invalid", "/different");
    stored.parts = [{ id: "invalid", sessionID: "session-a", messageID: "invalid", type: "text", text: "/different", metadata }];
    expect(history(snapshot([stored]))).toEqual([]);
  }
  for (const flags of [{ synthetic: true }, { ignored: true }]) {
    const stored = message("hidden", "");
    const part = { id: "hidden", sessionID: "session-a", messageID: "hidden", type: "text", text: "/compact", metadata: { openworkComposerToken: token }, ...flags } satisfies TextPart;
    stored.parts = [part];
    expect(history(snapshot([stored]))).toEqual([]);
    expect(textPartToUIPart(part)).toBeNull();
  }
  expect(history(snapshot([message("original-token", `${token} Keep the details.`)]))).toEqual([`${token} Keep the details.`]);
});
