import { describe, expect, test } from "bun:test";
import {
  composerPillInstruction,
  composerPillPromptParts,
  composerPillText,
  parseComposerPillToken,
  readComposerPill,
  splitComposerPillText,
  type ComposerPill,
} from "../src/react-app/domains/session/surface/composer/composer-pills";
import { connectorPrompt } from "../src/react-app/domains/session/surface/composer/connector-token";
import { encodeConnectSkillToken } from "../src/react-app/domains/session/surface/composer/connect-skill-token";
import { draftToParts } from "../src/react-app/domains/session/sync/draft-parts";
import { textPartToUIPart } from "../src/react-app/domains/session/sync/usechat-adapter";

const connector: ComposerPill = { kind: "connector", name: "GitHub" };
const connectSkill: ComposerPill = { kind: "connect-skill", slug: "release", name: "Release", marketplace: "Acme", capability: "plugin:acme:release" };

describe("composer pills", () => {
  test("every pill sends short visible text plus a synthetic instruction", () => {
    for (const pill of [connector, connectSkill, { kind: "skill", name: "release" }, { kind: "app", name: "Notes" }, { kind: "computer", target: "cloud" }] satisfies ComposerPill[]) {
      const [visible, instruction] = composerPillPromptParts(pill);
      expect(visible.text).toBe(composerPillText(pill));
      expect(visible.synthetic).toBeUndefined();
      expect(readComposerPill(visible.metadata?.openworkComposerPill)).toEqual(pill);
      expect(instruction.synthetic).toBe(true);
      expect(instruction.text).toBe(composerPillInstruction(pill));
    }
  });

  test("a connector pill never expands into the user's visible text", async () => {
    const parts = await draftToParts(
      { mode: "prompt", text: "[connector GitHub] Explain this repo", parts: [{ type: "connector", name: "GitHub" }, { type: "text", text: " Explain this repo" }], attachments: [] },
      "/workspace",
      "ses_1",
      null,
    );
    const visible = parts.filter((part) => part.type === "text" && !part.synthetic).map((part) => part.type === "text" ? part.text : "");
    expect(visible.join("")).toBe("[connector GitHub] Explain this repo");
    expect(visible.join("")).not.toContain("This request is about");
    expect(parts.some((part) => part.type === "text" && part.synthetic && part.text === connectorPrompt("GitHub"))).toBe(true);
  });

  test("the transcript keeps the pill identity of a sent text part", () => {
    const [visible] = composerPillPromptParts(connector);
    const mapped = textPartToUIPart({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: visible.text, metadata: visible.metadata });
    expect(mapped?.type === "text" ? mapped.providerMetadata?.opencode?.composerPill : null).toEqual(connector);
  });

  test("parses every bracket token the composer stores", () => {
    expect(parseComposerPillToken("[connector GitHub]")).toEqual(connector);
    expect(parseComposerPillToken("[skill release]")).toEqual({ kind: "skill", name: "release" });
    expect(parseComposerPillToken(encodeConnectSkillToken(connectSkill))).toEqual(connectSkill);
    expect(parseComposerPillToken("plain")).toBeNull();
  });

  test("renders tokens and expanded instructions in plain text as pills", () => {
    expect(splitComposerPillText("[connector GitHub] Explain")).toEqual([connector, " Explain"]);
    // Older sends and flattened (v2) prompts carry the instruction inline.
    expect(splitComposerPillText(`${connectorPrompt("GitHub")} Explain`)).toEqual([connector, " Explain"]);
    expect(splitComposerPillText(`[connector GitHub]${connectorPrompt("GitHub")} Explain`)).toEqual([connector, " Explain"]);
    expect(splitComposerPillText("Use Load [skill release] and follow its instructions. now")).toEqual(["Use ", { kind: "skill", name: "release" }, " now"]);
    const app = composerPillInstruction({ kind: "app", name: "Notes" });
    expect(splitComposerPillText(`@Notes${app} open it`)).toEqual([{ kind: "app", name: "Notes" }, " open it"]);
    expect(splitComposerPillText(`hi ${composerPillInstruction({ kind: "computer", target: "desktop" })}`)).toEqual(["hi ", { kind: "computer", target: "desktop" }]);
    expect(splitComposerPillText("no pills here")).toEqual(["no pills here"]);
  });

  test("rejects malformed pill metadata", () => {
    expect(readComposerPill({ kind: "computer", target: "laptop" })).toBeNull();
    expect(readComposerPill({ kind: "connector" })).toBeNull();
    expect(readComposerPill("connector")).toBeNull();
  });
});
