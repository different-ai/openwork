import { buildBundleNarrative, collectBundleItems, escapeHtml, getBundleCounts, humanizeType, parseBundle } from "./share-utils.js";

function escapeSvgText(value) {
  return escapeHtml(String(value ?? ""));
}

function toneFill(tone) {
  if (tone === "agent") return "url(#agentGradient)";
  if (tone === "mcp") return "url(#mcpGradient)";
  if (tone === "command") return "url(#commandGradient)";
  return "url(#skillGradient)";
}

function renderItem(item, index) {
  const y = 222 + index * 58;
  return `
    <g transform="translate(710 ${y})">
      <rect width="400" height="46" rx="18" fill="rgba(255,255,255,0.86)" stroke="rgba(255,255,255,0.92)" />
      <rect x="16" y="11" width="24" height="24" rx="8" fill="${toneFill(item.tone)}" />
      <text x="56" y="22" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(item.name)}</text>
      <text x="56" y="37" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="12">${escapeSvgText(`${item.kind} · ${item.meta}`)}</text>
    </g>`;
}

function renderStats(stats) {
  return stats
    .filter((stat) => stat.value)
    .map((stat, index) => {
      const x = 96 + index * 132;
      return `
        <g transform="translate(${x} 500)">
          <rect width="116" height="60" rx="20" fill="rgba(255,255,255,0.78)" stroke="rgba(255,255,255,0.9)" />
          <text x="18" y="24" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="11" font-weight="600" letter-spacing="1.2">${escapeSvgText(stat.label.toUpperCase())}</text>
          <text x="18" y="47" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">${escapeSvgText(String(stat.value))}</text>
        </g>`;
    })
    .join("");
}

function renderBaseCard(title, subtitle, eyebrow, items, stats, kicker) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgWarm" x1="80" y1="50" x2="470" y2="300" gradientUnits="userSpaceOnUse">
      <stop stop-color="#fbbf24" stop-opacity="0.58" />
      <stop offset="1" stop-color="#fbbf24" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="bgCool" x1="960" y1="44" x2="760" y2="280" gradientUnits="userSpaceOnUse">
      <stop stop-color="#60a5fa" stop-opacity="0.42" />
      <stop offset="1" stop-color="#60a5fa" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="skillGradient" x1="16" y1="11" x2="40" y2="35" gradientUnits="userSpaceOnUse">
      <stop stop-color="#f97316" />
      <stop offset="1" stop-color="#facc15" />
    </linearGradient>
    <linearGradient id="agentGradient" x1="16" y1="11" x2="40" y2="35" gradientUnits="userSpaceOnUse">
      <stop stop-color="#1d4ed8" />
      <stop offset="1" stop-color="#60a5fa" />
    </linearGradient>
    <linearGradient id="mcpGradient" x1="16" y1="11" x2="40" y2="35" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0f766e" />
      <stop offset="1" stop-color="#2dd4bf" />
    </linearGradient>
    <linearGradient id="commandGradient" x1="16" y1="11" x2="40" y2="35" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7c3aed" />
      <stop offset="1" stop-color="#c084fc" />
    </linearGradient>
    <filter id="cardShadow" x="0" y="0" width="1200" height="630" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="36" stdDeviation="28" flood-color="#0f172a" flood-opacity="0.12" />
    </filter>
  </defs>
  <rect width="1200" height="630" fill="#f6f9fc" />
  <circle cx="180" cy="120" r="210" fill="url(#bgWarm)" />
  <circle cx="1020" cy="120" r="190" fill="url(#bgCool)" />
  <rect x="72" y="58" width="1056" height="514" rx="44" fill="rgba(255,255,255,0.72)" stroke="rgba(255,255,255,0.9)" filter="url(#cardShadow)" />
  <rect x="72" y="58" width="1056" height="514" rx="44" fill="rgba(255,255,255,0.54)" />
  <text x="96" y="108" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="2.2">${escapeSvgText(eyebrow.toUpperCase())}</text>
  <text x="96" y="180" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="56" font-weight="700" letter-spacing="-2.4">${escapeSvgText(title)}</text>
  <text x="96" y="226" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="24">${escapeSvgText(subtitle)}</text>
  <text x="96" y="286" fill="#011627" font-family="Georgia, 'Times New Roman', serif" font-size="30" font-style="italic">${escapeSvgText(kicker)}</text>
  ${renderStats(stats)}
  <text x="710" y="152" fill="#5f6b7a" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="2.1">INCLUDED</text>
  ${items.map(renderItem).join("")}
</svg>`;
}

export function renderRootOgImage() {
  return renderBaseCard(
    "Package your worker",
    "Drop skills, agents, or MCPs into OpenWork Share.",
    "OpenWork Share",
    [
      { name: "Sales Inbound", kind: "Agent", meta: "v1.2.0", tone: "agent" },
      { name: "crm-sync", kind: "MCP", meta: "Remote MCP", tone: "mcp" },
      { name: "follow-up-reminder", kind: "Skill", meta: "Trigger · daily", tone: "skill" },
    ],
    [
      { label: "skills", value: 1 },
      { label: "agents", value: 1 },
      { label: "MCPs", value: 1 },
    ],
    "One drop. One share link.",
  );
}

export function renderBundleOgImage({ id, rawJson }) {
  const bundle = parseBundle(rawJson);
  const counts = getBundleCounts(bundle);
  const items = collectBundleItems(bundle, 5);
  const stats = [
    { label: "skills", value: counts.skillCount },
    { label: "agents", value: counts.agentCount },
    { label: "MCPs", value: counts.mcpCount },
    { label: "commands", value: counts.commandCount },
  ];

  return renderBaseCard(
    bundle.name || `OpenWork ${humanizeType(bundle.type)}`,
    buildBundleNarrative(bundle),
    `${humanizeType(bundle.type)} · ${id.slice(-8)}`,
    items.length ? items : [{ name: "OpenWork bundle", kind: humanizeType(bundle.type), meta: "Shared config", tone: "skill" }],
    stats,
    "Open directly in a new worker.",
  );
}
