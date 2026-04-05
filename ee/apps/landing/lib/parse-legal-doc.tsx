import { ReactNode } from "react";

export type Block =
  | { type: "heading"; text: string }
  | { type: "subheading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "definition-list"; items: { term: string; definition: string }[] };

export interface ParsedLegalDoc {
  title: string;
  effectiveDate: string;
  blocks: Block[];
}

/** Parse a plain-text legal document into renderable blocks. */
export function parseLegalDoc(raw: string): ParsedLegalDoc {
  const lines = raw.split("\n");
  const title = lines[0]?.trim() ?? "";

  // Extract "Effective date: ..." line
  const dateLine = lines.find((l) =>
    l.toLowerCase().startsWith("effective date")
  );
  const effectiveDate =
    dateLine?.replace(/^effective date:\s*/i, "").trim() ?? "";

  // Everything after the date line is body content.
  const dateIdx = lines.indexOf(dateLine ?? "");
  const bodyLines = lines.slice(dateIdx + 1);

  // Split into blocks separated by blank lines.
  const rawBlocks: string[][] = [];
  let current: string[] = [];
  for (const line of bodyLines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        rawBlocks.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) rawBlocks.push(current);

  // Classify each block.
  const blocks: Block[] = [];

  for (const block of rawBlocks) {
    const joined = block.join(" ").trim();
    const allList = block.every((l) => l.trimStart().startsWith("-"));
    const allDefinitions = block.length > 1 && block.every((l) => l.trimStart().startsWith('"'));

    if (allDefinitions) {
      // Definition list: lines like "Term" means ...
      const items = block.map((l) => {
        const trimmed = l.trim();
        const match = trimmed.match(/^"([^"]+)"(?:\s+or\s+"[^"]+")*\s+means\s+(.+)$/);
        if (match) {
          // Extract all quoted terms (e.g. "PII" or "Personally Identifiable Information")
          const termMatch = trimmed.match(/^("(?:[^"]+)"(?:\s+or\s+"[^"]+")*)\s+means\s+/);
          const term = termMatch ? termMatch[1] : match[1];
          return { term, definition: match[2] };
        }
        // Fallback: split on first " means "
        const meansIdx = trimmed.indexOf(" means ");
        if (meansIdx > 0) {
          return {
            term: trimmed.slice(0, meansIdx).replace(/^"|"$/g, ""),
            definition: trimmed.slice(meansIdx + 7)
          };
        }
        return { term: "", definition: trimmed };
      });
      blocks.push({ type: "definition-list", items });
    } else if (allList) {
      const items = block.map((l) => l.replace(/^\s*-/, "").trim());
      // Single-item short lists are subheadings (e.g. "Cookies", "Local Storage")
      if (items.length === 1 && items[0].length < 50) {
        blocks.push({ type: "subheading", text: items[0] });
      } else {
        blocks.push({ type: "list", items });
      }
    } else if (
      block.length === 1 &&
      joined.length < 120 &&
      !joined.startsWith("-") &&
      !joined.endsWith(".")
    ) {
      // Distinguish headings (h2) from subheadings (h3):
      // Questions and longer titles are main headings.
      // Short section names are subheadings.
      const isMainHeading = joined.endsWith("?") || joined.length > 35;
      if (isMainHeading) {
        blocks.push({ type: "heading", text: joined });
      } else {
        blocks.push({ type: "subheading", text: joined });
      }
    } else {
      blocks.push({ type: "paragraph", text: joined });
    }
  }

  return { title, effectiveDate, blocks };
}

/** Check if a string is mostly ALL CAPS (>80% uppercase letters). */
function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 20) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.8;
}

/** Turn email addresses and URLs into clickable links, bold ALL CAPS segments. */
export function formatText(text: string): ReactNode {
  // Split on emails and URLs
  const tokenRegex =
    /((?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|(?:https?:\/\/[^\s,)]+))/g;
  const parts = text.split(tokenRegex);
  if (parts.length === 1) {
    // No emails or URLs — check if entire text is ALL CAPS
    if (isAllCaps(text)) {
      return <strong className="font-semibold">{text}</strong>;
    }
    return text;
  }
  return parts.map((part, i) => {
    if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(part)) {
      return (
        <a
          key={i}
          href={`mailto:${part}`}
          className="text-[#011627] underline hover:opacity-70"
        >
          {part}
        </a>
      );
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="text-[#011627] underline hover:opacity-70"
        >
          {part}
        </a>
      );
    }
    if (isAllCaps(part)) {
      return (
        <strong key={i} className="font-semibold">
          {part}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/** Format a paragraph, splitting ALL CAPS sentences into bold segments. */
function formatParagraph(text: string): ReactNode {
  // Check if the whole paragraph is ALL CAPS
  if (isAllCaps(text)) {
    return <strong className="font-semibold">{formatText(text)}</strong>;
  }

  // Split on sentence boundaries to find ALL CAPS sentences within mixed paragraphs
  // Look for transitions between caps and non-caps sections
  const capsPattern = /([A-Z][A-Z\s,;:()\-—.'"/\d]+[A-Z.)](?:\s|$))/g;
  const segments = text.split(capsPattern);

  if (segments.length <= 1) return formatText(text);

  return segments.map((segment, i) => {
    if (isAllCaps(segment)) {
      return (
        <strong key={i} className="font-semibold">
          {formatText(segment)}
        </strong>
      );
    }
    return <span key={i}>{formatText(segment)}</span>;
  });
}

/** Render parsed legal doc blocks into React elements. */
export function renderBlocks(blocks: Block[]): ReactNode {
  return blocks.map((block, i) => {
    switch (block.type) {
      case "heading":
        return (
          <h2
            key={i}
            className="mb-3 mt-10 text-xl font-semibold tracking-tight text-[#011627] first:mt-0"
          >
            {block.text}
          </h2>
        );
      case "subheading":
        return (
          <h3
            key={i}
            className="mb-2 mt-6 text-base font-semibold text-[#011627]"
          >
            {block.text}
          </h3>
        );
      case "definition-list":
        return (
          <ul
            key={i}
            className="mb-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-gray-700"
          >
            {block.items.map((item, j) => (
              <li key={j}>
                <strong className="font-semibold text-[#011627]">
                  {item.term}
                </strong>{" "}
                means {formatText(item.definition)}
              </li>
            ))}
          </ul>
        );
      case "list":
        return (
          <ul
            key={i}
            className="mb-4 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700"
          >
            {block.items.map((item, j) => {
              const colonIdx = item.indexOf(":");
              if (colonIdx > 0 && colonIdx < 40) {
                return (
                  <li key={j}>
                    <strong className="font-semibold text-[#011627]">
                      {item.slice(0, colonIdx)}
                    </strong>
                    :{formatText(item.slice(colonIdx + 1))}
                  </li>
                );
              }
              return <li key={j}>{formatText(item)}</li>;
            })}
          </ul>
        );
      case "paragraph":
        return (
          <p
            key={i}
            className="mb-4 text-[15px] leading-relaxed text-gray-700"
          >
            {formatParagraph(block.text)}
          </p>
        );
    }
  });
}
