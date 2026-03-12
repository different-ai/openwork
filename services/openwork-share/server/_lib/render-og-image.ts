import type { PreviewItem } from "../../components/share-home-types.ts";
import { buildBundleNarrative, buildBundlePreview, collectBundleItems, escapeHtml, getBundleCounts, humanizeType, parseBundle } from "./share-utils.ts";

function escapeSvgText(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

function toneFill(tone: string): string {
  if (tone === "agent") return "url(#agentGradient)";
  if (tone === "mcp") return "url(#mcpGradient)";
  if (tone === "command") return "url(#commandGradient)";
  if (tone === "config") return "url(#configGradient)";
  return "url(#skillGradient)";
}

function truncateLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\t/g, "  ");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function wrapText(value: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharsPerLine) {
      current = next;
      continue;
    }

    if (current) lines.push(current);
    current = word;

    if (lines.length === maxLines - 1) break;
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }

  if (words.join(" ").length > lines.join(" ").length && lines.length) {
    lines[lines.length - 1] = truncateLine(lines[lines.length - 1]!, maxCharsPerLine);
    if (!lines[lines.length - 1]!.endsWith("…")) {
      lines[lines.length - 1] = `${truncateLine(lines[lines.length - 1]!, Math.max(1, maxCharsPerLine - 1))}…`;
    }
  }

  return lines;
}

function previewLineColor(value: string): string {
  if (/^#{1,6}\s/.test(value)) return "#011627";
  if (/^\s*[-*]\s+[a-z_]+:/.test(value)) return "#be123c";
  if (/^\s*[-*]\s/.test(value)) return "#7c3aed";
  if (/https?:\/\//.test(value)) return "#2563eb";
  if (/^\s*[{}\[\]"]/.test(value)) return "#0f766e";
  return "#5f6b7a";
}

function renderStatPills(stats: { label: string; value: number }[], y: number): string {
  return stats
    .filter((stat) => stat.value)
    .slice(0, 4)
    .map((stat, index) => {
      const x = 96 + index * 108;
      return `
        <g transform="translate(${x} ${y})">
          <rect width="96" height="56" rx="20" fill="rgba(255,255,255,0.84)" stroke="rgba(255,255,255,0.92)" />
          <text x="16" y="23" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="700" letter-spacing="1.2">${escapeSvgText(stat.label.toUpperCase())}</text>
          <text x="16" y="42" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">${escapeSvgText(String(stat.value))}</text>
        </g>`;
    })
    .join("");
}

function renderItemRows(items: PreviewItem[], y: number): string {
  return items
    .slice(0, 3)
    .map((item, index) => {
      const rowY = y + index * 44;
      return `
        <g transform="translate(96 ${rowY})">
          <rect width="430" height="36" rx="16" fill="rgba(248,250,252,0.9)" stroke="rgba(148,163,184,0.16)" />
          <rect x="12" y="8" width="20" height="20" rx="10" fill="${toneFill(item.tone)}" />
          <text x="44" y="20" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(truncateLine(item.name, 28))}</text>
          <text x="44" y="33" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="11">${escapeSvgText(truncateLine(`${item.kind} · ${item.meta}`, 42))}</text>
        </g>`;
    })
    .join("");
}

function renderPreviewPanel(preview: { filename: string; text: string; tone: string; label: string }): string {
  const lines = preview.text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 10);

  return `
    <g transform="translate(628 88)">
      <rect width="472" height="454" rx="30" fill="rgba(255,255,255,0.94)" stroke="rgba(148,163,184,0.18)" />
      <path d="M0 68H472" stroke="rgba(148,163,184,0.14)" />
      <text x="28" y="42" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="700" letter-spacing="1.8">PREVIEW</text>
      <text x="28" y="408" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="11">${escapeSvgText(truncateLine(preview.label, 44))}</text>
      <text x="28" y="430" fill="#94a3b8" font-family="JetBrains Mono, Menlo, monospace" font-size="11">${escapeSvgText(truncateLine(preview.filename, 38))}</text>
      <rect x="330" y="26" width="10" height="10" rx="5" fill="#94a3b8" />
      <text x="346" y="35" fill="#94a3b8" font-family="JetBrains Mono, Menlo, monospace" font-size="11">${escapeSvgText(truncateLine(preview.filename, 16))}</text>
      ${lines
        .map((line, index) => {
          const y = 104 + index * 28;
          return `
            <g transform="translate(28 ${y})">
              <text x="0" y="0" fill="#cbd5e1" font-family="JetBrains Mono, Menlo, monospace" font-size="11">${String(index + 1).padStart(2, "0")}</text>
              <text x="32" y="0" fill="${previewLineColor(line)}" font-family="JetBrains Mono, Menlo, monospace" font-size="15">${escapeSvgText(truncateLine(line, 42))}</text>
            </g>`;
        })
        .join("")}
    </g>`;
}

function renderBaseCard(input: {
  title: string;
  subtitle: string;
  eyebrow: string;
  items: PreviewItem[];
  stats: { label: string; value: number }[];
  preview: { filename: string; text: string; tone: string; label: string };
  kicker: string;
}): string {
  const titleLines = wrapText(input.title, 18, 2);
  const subtitleLines = wrapText(input.subtitle, 42, 2);
  const titleStartY = 146;
  const titleLineHeight = 52;
  const subtitleStartY = titleStartY + titleLines.length * titleLineHeight + 22;
  const subtitleLineHeight = 24;
  const statsY = subtitleStartY + subtitleLines.length * subtitleLineHeight + 28;
  const kickerY = statsY + 78;
  const listCardY = kickerY + 24;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgWarm" x1="64" y1="48" x2="360" y2="292" gradientUnits="userSpaceOnUse">
      <stop stop-color="#fbbf24" stop-opacity="0.58" />
      <stop offset="1" stop-color="#fbbf24" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="bgCool" x1="1100" y1="36" x2="804" y2="250" gradientUnits="userSpaceOnUse">
      <stop stop-color="#60a5fa" stop-opacity="0.36" />
      <stop offset="1" stop-color="#60a5fa" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="skillGradient" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop stop-color="#f97316" />
      <stop offset="1" stop-color="#facc15" />
    </linearGradient>
    <linearGradient id="agentGradient" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop stop-color="#1d4ed8" />
      <stop offset="1" stop-color="#60a5fa" />
    </linearGradient>
    <linearGradient id="mcpGradient" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0f766e" />
      <stop offset="1" stop-color="#2dd4bf" />
    </linearGradient>
    <linearGradient id="commandGradient" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7c3aed" />
      <stop offset="1" stop-color="#c084fc" />
    </linearGradient>
    <linearGradient id="configGradient" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop stop-color="#334155" />
      <stop offset="1" stop-color="#94a3b8" />
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
  <rect x="96" y="88" width="140" height="34" rx="17" fill="rgba(255,255,255,0.88)" stroke="rgba(255,255,255,0.94)" />
  <text x="114" y="109" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="1.9">${escapeSvgText(input.eyebrow.toUpperCase())}</text>
  ${titleLines
    .map((line, index) => `<text x="96" y="${titleStartY + index * titleLineHeight}" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="50" font-weight="700" letter-spacing="-2">${escapeSvgText(line)}</text>`)
    .join("")}
  ${subtitleLines
    .map((line, index) => `<text x="96" y="${subtitleStartY + index * subtitleLineHeight}" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="22">${escapeSvgText(line)}</text>`)
    .join("")}
  ${renderStatPills(input.stats, statsY)}
  <text x="96" y="${kickerY}" fill="#011627" font-family="Georgia, 'Times New Roman', serif" font-size="26" font-style="italic">${escapeSvgText(input.kicker)}</text>
  <g transform="translate(84 ${listCardY})">
    <rect width="456" height="156" rx="28" fill="rgba(255,255,255,0.88)" stroke="rgba(255,255,255,0.94)" />
    <text x="20" y="28" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="1.8">PACKAGE CONTENTS</text>
  </g>
  ${renderItemRows(input.items, listCardY + 34)}
  ${renderPreviewPanel(input.preview)}
</svg>`;
}

export function renderRootOgImage(): string {
  return renderBaseCard({
    title: "Package your worker",
    subtitle: "Drop skills, agents, or MCPs into OpenWork Share.",
    eyebrow: "OpenWork Share",
    items: [
      { name: "Sales Inbound", kind: "Agent", meta: "v1.2.0", tone: "agent" },
      { name: "meeting-reminder", kind: "Skill", meta: "Trigger · daily", tone: "skill" },
      { name: "crm-sync", kind: "MCP", meta: "Remote MCP", tone: "mcp" },
    ],
    stats: [
      { label: "skills", value: 1 },
      { label: "agents", value: 1 },
      { label: "MCPs", value: 1 },
    ],
    preview: {
      filename: "meeting-reminder.md",
      label: "Skill preview",
      tone: "skill",
      text: `# meeting-reminder\n\nA skill that sends a follow-up reminder after a configurable delay.\n\n## Trigger\n\nRuns automatically when a conversation has been idle for the configured duration.\n\n- delay: Duration before triggering\n- channel: Send via email, slack, or in-app`,
    },
    kicker: "",
  });
}

export function renderBundleOgImage({ id, rawJson }: { id: string; rawJson: string }): string {
  const bundle = parseBundle(rawJson);
  const counts = getBundleCounts(bundle);
  const items = collectBundleItems(bundle, 5);
  const preview = buildBundlePreview(bundle);

  return renderBaseCard({
    title: bundle.name || `OpenWork ${humanizeType(bundle.type)}`,
    subtitle: buildBundleNarrative(bundle),
    eyebrow: `${humanizeType(bundle.type)} · ${id.slice(-8)}`,
    items: items.length ? items : [{ name: "OpenWork bundle", kind: "Skill", meta: "Shared config", tone: "skill" }],
    stats: [
      { label: "skills", value: counts.skillCount },
      { label: "agents", value: counts.agentCount },
      { label: "MCPs", value: counts.mcpCount },
      { label: "commands", value: counts.commandCount },
    ],
    preview,
    kicker: "",
  });
}
