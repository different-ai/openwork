import { ReactNode } from "react";

/**
 * Minimal markdown-to-JSX renderer for legal pages.
 * Supports: headings, bold, links, lists, blockquotes, horizontal rules, paragraphs.
 * No external dependencies.
 */

/** Render inline markdown (bold, links) within a text string. */
function renderInline(text: string): ReactNode {
  // Split on **bold**, [text](url), and bare URLs
  const parts: ReactNode[] = [];
  const regex =
    /(\*\*(.+?)\*\*)|(\[([^\]]+)\]\(([^)]+)\))|(https?:\/\/[^\s,)<>]+[^\s,)<>.;:])|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // **bold**
      parts.push(
        <strong key={match.index} className="font-semibold text-[#011627]">
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      // [text](url)
      const href = match[5];
      const isExternal = href.startsWith("http");
      parts.push(
        <a
          key={match.index}
          href={href}
          {...(isExternal ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          {match[4]}
        </a>
      );
    } else if (match[6]) {
      // bare URL
      parts.push(
        <a key={match.index} href={match[6]} target="_blank" rel="noreferrer">
          {match[6]}
        </a>
      );
    } else if (match[7]) {
      // email
      parts.push(
        <a key={match.index} href={`mailto:${match[7]}`}>
          {match[7]}
        </a>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : parts;
}

/** Parse a markdown string and return React elements. */
export function renderMarkdown(md: string): ReactNode {
  const lines = md.split("\n");
  const elements: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      if (level === 1) {
        elements.push(<h1 key={key++}>{renderInline(text)}</h1>);
      } else if (level === 2) {
        elements.push(<h2 key={key++}>{renderInline(text)}</h2>);
      } else {
        elements.push(<h3 key={key++}>{renderInline(text)}</h3>);
      }
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={key++} />);
      i++;
      continue;
    }

    // Blockquote — collect consecutive > lines
    if (line.startsWith(">")) {
      const bqLines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        bqLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      elements.push(
        <blockquote key={key++}>
          {renderMarkdown(bqLines.join("\n"))}
        </blockquote>
      );
      continue;
    }

    // List — collect consecutive - lines
    if (line.match(/^\s*-\s/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*-\s/)) {
        items.push(lines[i].replace(/^\s*-\s/, ""));
        i++;
      }
      elements.push(
        <ul key={key++}>
          {items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Paragraph — collect consecutive non-blank, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^#{1,3}\s/) &&
      !lines[i].match(/^\s*-\s/) &&
      !lines[i].startsWith(">") &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      elements.push(<p key={key++}>{renderInline(paraLines.join(" "))}</p>);
    }
  }

  return elements;
}
