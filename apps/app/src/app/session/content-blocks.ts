import { marked } from "marked";
import remend from "remend";
import { detectStandaloneFileReference } from "./file-links";

export type SessionContentBlock =
  | {
      kind: "markdown";
      id: string;
      raw: string;
    }
  | {
      kind: "code";
      id: string;
      raw: string;
      code: string;
      lang: string;
    }
  | {
      kind: "file";
      id: string;
      raw: string;
      path: string;
      label?: string;
    };

type MarkedToken = {
  type?: string;
  raw?: string;
  text?: string;
  lang?: string;
};

const blockId = (kind: SessionContentBlock["kind"], index: number, raw: string) =>
  `${kind}:${index}:${raw.slice(0, 80)}`;

const reuseBlock = (previous: SessionContentBlock[] | undefined, index: number, next: SessionContentBlock) => {
  const existing = previous?.[index];
  if (!existing) return next;

  if (existing.kind !== next.kind) return next;
  if (existing.raw !== next.raw) return next;
  if (existing.kind === "code" && next.kind === "code") {
    if (existing.code !== next.code || existing.lang !== next.lang) return next;
  }
  if (existing.kind === "file" && next.kind === "file") {
    if (existing.path !== next.path || existing.label !== next.label) return next;
  }
  return existing;
};

const tokenRaw = (token: MarkedToken) => (typeof token.raw === "string" ? token.raw : "");

const tokenToBlock = (token: MarkedToken, index: number): SessionContentBlock | null => {
  const raw = tokenRaw(token);
  if (!raw.trim()) return null;

  if (token.type === "code") {
    const code = typeof token.text === "string" ? token.text : raw;
    const lang = typeof token.lang === "string" ? token.lang : "";
    return {
      kind: "code",
      id: blockId("code", index, raw),
      raw,
      code,
      lang,
    };
  }

  if (token.type === "paragraph") {
    const reference = detectStandaloneFileReference(raw);
    if (reference) {
      return {
        kind: "file",
        id: blockId("file", index, raw),
        raw,
        path: reference.path,
        label: reference.label,
      };
    }
  }

  return {
    kind: "markdown",
    id: blockId("markdown", index, raw),
    raw,
  };
};

export const splitSessionContentBlocks = (
  value: string,
  previous: SessionContentBlock[] = [],
): SessionContentBlock[] => {
  const healed = remend(value, { inlineKatex: false });
  const tokens = marked.lexer(healed, { gfm: true, breaks: true }) as MarkedToken[];
  const next: SessionContentBlock[] = [];

  tokens.forEach((token, index) => {
    const block = tokenToBlock(token, index);
    if (!block) return;
    next.push(reuseBlock(previous, next.length, block));
  });

  return next;
};
