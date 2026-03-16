import { highlightSyntax } from "../../components/share-preview-syntax.ts";
import { DEFAULT_PUBLIC_BASE_URL, buildBundlePreview, maybeString, parseBundle, parseFrontmatter } from "./share-utils.ts";

type TokenClass =
  | "plain"
  | "hl-frontmatter"
  | "hl-key"
  | "hl-url"
  | "hl-string"
  | "hl-bracket"
  | "hl-punctuation"
  | "hl-number"
  | "hl-keyword"
  | "hl-comment"
  | "hl-heading"
  | "hl-field"
  | "hl-inline-code"
  | "hl-bold"
  | "hl-type"
  | "hl-cta"
  | "hl-cta-skill"
  | "hl-cta-url"
  | "hl-codeblock";

type TokenSegment = {
  text: string;
  className: TokenClass;
};

type WrappedLine = {
  lineNumber: number | null;
  segments: TokenSegment[];
};

export type OgTokenClass = TokenClass;
export type OgTokenSegment = TokenSegment;
export type OgWrappedLine = WrappedLine;
export type OgImageModel = {
  filename: string;
  lines: WrappedLine[];
};

type SkillCardInput = {
  title: string;
  filename: string;
  text: string;
  shareUrl: string;
};

const FONT_SIZE = 15;
const LINE_HEIGHT = 22;
const BODY_X = 34;
const BODY_Y = 116;
const BODY_WIDTH = 1084;
const BODY_HEIGHT = 454;
const CHAR_WIDTH = 8.9;
const OG_SANS_FONT = "DejaVu Sans, Liberation Sans, Arial, sans-serif";
const OG_MONO_FONT = "DejaVu Sans Mono, Liberation Mono, Courier New, monospace";
const MAX_LINES = Math.floor(BODY_HEIGHT / LINE_HEIGHT);

function escapeSvgText(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function humanizeSkillName(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function parseHighlightedLine(lineHtml: string): TokenSegment[] {
  if (!lineHtml) return [{ text: "", className: "plain" }];

  const segments: TokenSegment[] = [];
  const pattern = /<span class="([^"]+)">([\s\S]*?)<\/span>/g;
  let lastIndex = 0;

  for (const match of lineHtml.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({
        text: decodeHtml(lineHtml.slice(lastIndex, index)),
        className: "plain",
      });
    }

    segments.push({
      text: decodeHtml(match[2] ?? ""),
      className: ((match[1] as TokenClass) || "plain"),
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < lineHtml.length) {
    segments.push({
      text: decodeHtml(lineHtml.slice(lastIndex)),
      className: "plain",
    });
  }

  return segments.filter((segment) => segment.text.length > 0 || segment.className === "plain");
}

function detectQuotedCodeSegments(rawLine: string): TokenSegment[] | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  const wholeDoubleQuoted = trimmed.match(/^"[^"]+"$/);
  if (wholeDoubleQuoted) {
    return [{ text: trimmed, className: "hl-codeblock" }];
  }

  const wholeBackticked = trimmed.match(/^`[^`]+`$/);
  if (wholeBackticked) {
    return [{ text: trimmed, className: "hl-codeblock" }];
  }

  const bulletDoubleQuoted = rawLine.match(/^(\s*-\s+)("[^"]+")$/);
  if (bulletDoubleQuoted) {
    return [
      { text: bulletDoubleQuoted[1] ?? "", className: "hl-punctuation" },
      { text: bulletDoubleQuoted[2] ?? "", className: "hl-codeblock" },
    ];
  }

  const bulletBackticked = rawLine.match(/^(\s*-\s+)(`[^`]+`)$/);
  if (bulletBackticked) {
    return [
      { text: bulletBackticked[1] ?? "", className: "hl-punctuation" },
      { text: bulletBackticked[2] ?? "", className: "hl-codeblock" },
    ];
  }

  return null;
}

function sliceSegment(segment: TokenSegment, start: number, end?: number): TokenSegment {
  return {
    text: segment.text.slice(start, end),
    className: segment.className,
  };
}

function segmentWidth(text: string): number {
  return text.length * CHAR_WIDTH;
}

function wrapTokenSegments(segments: TokenSegment[], maxWidth: number): TokenSegment[][] {
  if (!segments.length) return [[{ text: "", className: "plain" }]];

  const wrapped: TokenSegment[][] = [];
  let currentLine: TokenSegment[] = [];
  let currentWidth = 0;
  const maxChars = Math.max(1, Math.floor(maxWidth / CHAR_WIDTH));

  const pushCurrent = () => {
    wrapped.push(currentLine.length ? currentLine : [{ text: "", className: "plain" }]);
    currentLine = [];
    currentWidth = 0;
  };

  for (const segment of segments) {
    const parts =
      segment.className === "hl-codeblock"
        ? [segment.text]
        : segment.text.split(/(\s+)/).filter((part) => part.length > 0);

    for (const part of parts) {
      let remaining = part;

      while (remaining.length > 0) {
        const partWidth = segmentWidth(remaining);
        if (currentWidth + partWidth <= maxWidth) {
          currentLine.push({ text: remaining, className: segment.className });
          currentWidth += partWidth;
          remaining = "";
          continue;
        }

        if (currentLine.length === 0) {
          const chunk = remaining.slice(0, maxChars);
          currentLine.push({ text: chunk, className: segment.className });
          currentWidth += segmentWidth(chunk);
          remaining = remaining.slice(chunk.length);
          pushCurrent();
          continue;
        }

        if (/^\s+$/.test(remaining)) {
          remaining = "";
          pushCurrent();
          continue;
        }

        pushCurrent();
      }
    }
  }

  if (currentLine.length) {
    pushCurrent();
  }

  return wrapped.length ? wrapped : [[{ text: "", className: "plain" }]];
}

function buildContinuationLines(shareUrl: string): TokenSegment[][] {
  const displayUrl = shareUrl.replace(/^https?:\/\/(www\.)?/, "");
  const segments: TokenSegment[] = [
    { text: "Continue to read and copy this ", className: "hl-cta" },
    { text: "SKILL.md", className: "hl-cta-skill" },
    { text: " at:", className: "hl-cta" },
    { text: displayUrl, className: "hl-cta-url" },
  ];
  return wrapTokenSegments(segments, BODY_WIDTH);
}

function buildWrappedLines(text: string, shareUrl: string): WrappedLine[] {
  const htmlLines = highlightSyntax(text).split("\n");
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const wrapped: WrappedLine[] = [];
  const continuationLines = buildContinuationLines(shareUrl);
  const maxContentLines = Math.max(1, MAX_LINES - continuationLines.length);
  let truncated = false;

  for (const [index, htmlLine] of htmlLines.entries()) {
    const quotedCodeSegments = detectQuotedCodeSegments(rawLines[index] ?? "");
    const parsed = quotedCodeSegments
      ? quotedCodeSegments
      : parseHighlightedLine(htmlLine);
    const lineGroups = wrapTokenSegments(parsed, BODY_WIDTH);
    for (const lineGroup of lineGroups) {
      if (wrapped.length === maxContentLines) {
        truncated = true;
        break;
      }
      wrapped.push({
        lineNumber: wrapped.length + 1,
        segments: lineGroup,
      });
    }
    if (truncated) break;
  }

  if (truncated) {
    wrapped.push({
      lineNumber: null,
      segments: [],
    });
    for (const continuationLine of continuationLines) {
      wrapped.push({
        lineNumber: null,
        segments: continuationLine,
      });
    }
  }

  return wrapped;
}

function buildSkillCardModel(input: SkillCardInput): OgImageModel {
  return {
    filename: input.filename,
    lines: buildWrappedLines(input.text, input.shareUrl),
  };
}

function classStyle(className: TokenClass): { fill: string; weight?: string; style?: string } {
  switch (className) {
    case "hl-frontmatter":
      return { fill: "#94a3b8" };
    case "hl-key":
      return { fill: "#475569" };
    case "hl-url":
      return { fill: "#2563eb" };
    case "hl-string":
      return { fill: "#0f766e" };
    case "hl-bracket":
      return { fill: "#94a3b8" };
    case "hl-punctuation":
      return { fill: "#94a3b8" };
    case "hl-number":
      return { fill: "#f97316" };
    case "hl-keyword":
      return { fill: "#be123c" };
    case "hl-comment":
      return { fill: "#94a3b8", style: "italic" };
    case "hl-heading":
      return { fill: "#0f172a", weight: "700" };
    case "hl-field":
      return { fill: "#be123c" };
    case "hl-inline-code":
      return { fill: "#7c3aed" };
    case "hl-bold":
      return { fill: "#0f172a", weight: "700" };
    case "hl-type":
      return { fill: "#0ea5e9", style: "italic" };
    case "hl-cta":
      return { fill: "#0f172a" };
    case "hl-cta-skill":
      return { fill: "#0f172a", weight: "700" };
    case "hl-cta-url":
      return { fill: "#0f172a", weight: "700" };
    case "hl-codeblock":
      return { fill: "#F99D16" };
    default:
      return { fill: "#475569" };
  }
}

function renderLine(line: WrappedLine, y: number): string {
  let x = BODY_X;
  const gutter = line.lineNumber == null ? "" : `<text x="${BODY_X}" y="${y}" fill="#cbd5e1" font-family="${OG_MONO_FONT}" font-size="13" font-weight="600">${String(line.lineNumber).padStart(2, "0")}</text>`;
  x += 44;

  return `${gutter}${line.segments
    .map((segment, index) => {
      const style = classStyle(segment.className);
      const width = segmentWidth(segment.text);
      const pill =
        segment.className === "hl-codeblock"
          ? `<rect x="${x - 1}" y="${y - 14}" width="${width + 8}" height="22" rx="5" fill="#f8fafc" stroke="#cbd5e1" />`
          : "";
      const node = `<text x="${x}" y="${y}" fill="${style.fill}" font-family="${OG_MONO_FONT}" font-size="${FONT_SIZE}"${style.weight ? ` font-weight="${style.weight}"` : ""}${style.style ? ` font-style="${style.style}"` : ""}${segment.className === "hl-cta-url" ? ` text-decoration="underline"` : ""}>${escapeSvgText(segment.text)}</text>`;
      x += width;
      return `${pill}${node}${index === line.segments.length - 1 ? "" : ""}`;
    })
    .join("")}`;
}

function renderPreviewSurface(input: { title: string; filename: string; text: string; shareUrl: string }): string {
  const model = buildSkillCardModel(input);

  return `
    <g transform="translate(18 12)">
      <rect width="1164" height="606" rx="38" fill="rgba(255,255,255,0.96)" stroke="rgba(148,163,184,0.16)" />
      <path d="M0 66H1164" stroke="rgba(226,232,240,0.92)" />
      <text x="34" y="42" fill="#0f172a" font-family="${OG_SANS_FONT}" font-size="28" font-weight="800" letter-spacing="-1.2">SKILL.md</text>
      <circle cx="930" cy="33" r="7" fill="url(#skillGradient)" />
      <text x="950" y="40" fill="#94a3b8" font-family="${OG_MONO_FONT}" font-size="16">${escapeSvgText(input.filename)}</text>
      ${model.lines.map((line, index) => renderLine(line, BODY_Y + index * LINE_HEIGHT)).join("")}
    </g>`;
}

function renderSkillCard(input: { title: string; filename: string; text: string; shareUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgWarm" x1="64" y1="48" x2="360" y2="292" gradientUnits="userSpaceOnUse">
      <stop stop-color="#F99D16" stop-opacity="0.58" />
      <stop offset="1" stop-color="#F99D16" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="bgCool" x1="1100" y1="36" x2="804" y2="250" gradientUnits="userSpaceOnUse">
      <stop stop-color="#111827" stop-opacity="0.22" />
      <stop offset="1" stop-color="#111827" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="skillGradient" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop stop-color="#f97316" />
      <stop offset="1" stop-color="#facc15" />
    </linearGradient>
    <filter id="cardShadow" x="0" y="0" width="1200" height="630" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="36" stdDeviation="28" flood-color="#0f172a" flood-opacity="0.14" />
    </filter>
  </defs>
  <rect width="1200" height="630" fill="#f6f9fc" />
  <circle cx="168" cy="120" r="210" fill="url(#bgWarm)" />
  <circle cx="1046" cy="108" r="200" fill="url(#bgCool)" />
  <rect x="48" y="44" width="1104" height="542" rx="42" fill="rgba(255,255,255,0.72)" stroke="rgba(255,255,255,0.9)" filter="url(#cardShadow)" />
  <rect x="48" y="44" width="1104" height="542" rx="42" fill="rgba(255,255,255,0.56)" />
  ${renderPreviewSurface(input)}
</svg>`;
}

function buildRootOgInput(): SkillCardInput {
  return {
    title: "Meeting Reminder",
    filename: "meeting-reminder.md",
    shareUrl: `${DEFAULT_PUBLIC_BASE_URL}/b/root`,
    text: `# Welcome to OpenWork

Hi, I'm Ben and this is OpenWork. It's an open-source alternative to Claude's cowork. It helps you work on your files with AI and automate the mundane tasks so you don't have to.

Before we start, use the question tool to ask:
"Are you more technical or non-technical? I'll tailor the explanation."

## If the person is non-technical
OpenWork feels like a chat app, but it can safely work with the files you allow. Put files in this workspace and I can summarize them, create new ones, or help organize them.

Try:
- "Summarize the files in this workspace."
- "Create a checklist for my week."
- "Draft a short summary from this document."

## Skills and plugins (simple)
Skills add new capabilities. Plugins add advanced features like scheduling or browser automation. We can add them later when you're ready.

## If the person is technical
OpenWork is a GUI for OpenCode. Everything that works in OpenCode works here.

Most reliable setup today:
1) Install OpenCode from opencode.ai
2) Configure providers there (models and API keys)
3) Come back to OpenWork and start a session

Skills:
- Install from the Skills tab, or add them to this workspace.
- Docs: https://opencode.ai/docs/skills

Plugins:
- Configure in opencode.json or use the Plugins tab.
- Docs: https://opencode.ai/docs/plugins/

MCP servers:
- Add external tools via opencode.json.
- Docs: https://opencode.ai/docs/mcp-servers/

Config reference:
- Docs: https://opencode.ai/docs/config/

End with two friendly next actions to try in OpenWork.`,
  };
}

function buildBundleOgInput({ id, rawJson }: { id: string; rawJson: string }): SkillCardInput {
  const bundle = parseBundle(rawJson);
  const preview = buildBundlePreview(bundle);
  const { data } = parseFrontmatter(bundle.content);
  const skillName = maybeString(data.name).trim() || bundle.name || "shared-skill";

  return {
    title: humanizeSkillName(skillName),
    filename: preview.filename || `${skillName}.md`,
    shareUrl: `${DEFAULT_PUBLIC_BASE_URL}/b/${id}`,
    text: bundle.content || preview.text || "",
  };
}

export function buildRootOgImageModel(): OgImageModel {
  return buildSkillCardModel(buildRootOgInput());
}

export function buildBundleOgImageModel({ id, rawJson }: { id: string; rawJson: string }): OgImageModel {
  return buildSkillCardModel(buildBundleOgInput({ id, rawJson }));
}

export function renderRootOgImage(): string {
  return renderSkillCard(buildRootOgInput());
}

export function renderBundleOgImage({ id, rawJson }: { id: string; rawJson: string }): string {
  return renderSkillCard(buildBundleOgInput({ id, rawJson }));
}
