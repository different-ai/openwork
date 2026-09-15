import { Marked } from "marked";

const parser = new Marked({ gfm: true, breaks: true, async: false });

export type ChatReplyPart = {
  start: number;
  text: string;
  markdown: string;
};

export function splitChatReply(text: string): ChatReplyPart[] {
  const tokens = parser.lexer(text);
  const definitions: string[] = [];
  parser.walkTokens(tokens, (token) => {
    if (token.type === "def") definitions.push(token.raw);
  });
  const context = definitions.length > 0 ? `${definitions.join("\n\n")}\n\n` : "";
  const boundaries = [0];
  let offset = 0;
  let paragraph = false;
  let separated = false;
  for (const token of tokens) {
    if (token.type === "space") {
      separated = paragraph && /\n[\t ]*\n/.test(token.raw);
    } else {
      if (token.type === "def" || (token.type === "paragraph" && /^ {0,3}\[/.test(token.raw))) break;
      if (separated) boundaries.push(offset);
      if (boundaries.length === 3 || token.type !== "paragraph") break;
      paragraph = true;
      separated = false;
    }
    offset += token.raw.length;
  }
  let sourceOffset = 0;
  let normalizedOffset = 0;
  const starts = boundaries.map((boundary) => {
    while (normalizedOffset < boundary) {
      sourceOffset += text[sourceOffset] === "\r" && text[sourceOffset + 1] === "\n" ? 2 : 1;
      normalizedOffset += 1;
    }
    return sourceOffset;
  });
  return starts.map((start, index) => {
    const part = text.slice(start, starts[index + 1]);
    return { start, text: part, markdown: `${context}${part}` };
  });
}
