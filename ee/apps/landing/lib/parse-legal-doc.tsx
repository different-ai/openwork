import { ReactNode } from "react";

export type Block =
  | { type: "heading"; text: string }
  | { type: "subheading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

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

    if (allList) {
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
      blocks.push({ type: "heading", text: joined });
    } else {
      blocks.push({ type: "paragraph", text: joined });
    }
  }

  return { title, effectiveDate, blocks };
}

/** Turn email addresses and URLs into clickable links. */
export function formatText(text: string): ReactNode {
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const parts = text.split(emailRegex);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    emailRegex.test(part) ? (
      <a
        key={i}
        href={`mailto:${part}`}
        className="text-[#011627] underline hover:opacity-70"
      >
        {part}
      </a>
    ) : (
      part
    )
  );
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
            {formatText(block.text)}
          </p>
        );
    }
  });
}
