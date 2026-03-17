import {
  DEFAULT_PUBLIC_BASE_URL,
  buildBundlePreview,
  humanizeType,
  maybeString,
  parseBundle,
  parseFrontmatter,
} from "./share-utils.ts";
import {
  BASE_OG_IMAGE_HEIGHT,
  BASE_OG_IMAGE_WIDTH,
  getOgImageVariantConfig,
  type OgImageVariant,
} from "./og-image-variants.ts";

export type OgImageModel = {
  title: string;
  fileName: string;
  fileType: string;
  description: string;
  category: string;
  tag: string;
  domain: string;
};

export type OgTitleTier = "xl" | "lg" | "md" | "sm" | "xs";

export type OgImageLayout = {
  displayTitle: string;
  titleTier: OgTitleTier;
  titleFontSize: number;
  titleLineHeight: number;
  titleLines: string[];
  showDescription: boolean;
  descriptionLines: string[];
};

type OgTextTierConfig = {
  fontSize: number;
  lineHeight: number;
  maxLines: number;
  charsPerLine: number;
};

const MAX_DISPLAY_CHARS = 55;
const MAX_DESCRIPTION_CHARS = 120;
const DEFAULT_DOMAIN = DEFAULT_PUBLIC_BASE_URL.replace(/^https?:\/\//, "");

const TITLE_TIER_CONFIG: Record<OgTitleTier, OgTextTierConfig> = {
  xl: { fontSize: 64, lineHeight: 68, maxLines: 1, charsPerLine: 18 },
  lg: { fontSize: 50, lineHeight: 56, maxLines: 2, charsPerLine: 18 },
  md: { fontSize: 40, lineHeight: 46, maxLines: 2, charsPerLine: 24 },
  sm: { fontSize: 32, lineHeight: 38, maxLines: 2, charsPerLine: 30 },
  xs: { fontSize: 26, lineHeight: 33, maxLines: 2, charsPerLine: 34 },
};

function escapeSvgText(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function humanizeTitle(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (/[A-Z]/.test(normalized)) return normalized;
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function truncateAtWordBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.6) {
    return `${truncated.slice(0, lastSpace)}...`;
  }
  return `${truncated}...`;
}

function splitTextIntoLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      if (lines.length === maxLines) {
        lines[lines.length - 1] = truncateAtWordBoundary(lines[lines.length - 1]!, maxCharsPerLine);
        return lines;
      }
      current = word;
      continue;
    }

    lines.push(truncateAtWordBoundary(word, maxCharsPerLine));
    if (lines.length === maxLines) {
      return lines;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }

  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = truncateAtWordBoundary(lines[lines.length - 1]!, maxCharsPerLine);
  }

  return lines;
}

function getTitleTier(length: number): OgTitleTier {
  if (length <= 10) return "xl";
  if (length <= 20) return "lg";
  if (length <= 35) return "md";
  if (length <= 50) return "sm";
  return "xs";
}

function inferFileType(fileName: string, category: string): string {
  const extension = (fileName.split(".").pop() || "").toLowerCase();
  if (extension === "md" && category === "command") return "COMMAND.md";
  if (extension === "md") return "SKILL.md";
  if (extension === "json") return "JSON";
  if (extension === "toml") return "TOML";
  if (extension === "yaml" || extension === "yml") return "YAML";
  return extension ? extension.toUpperCase() : "FILE";
}

function buildTagFromTrigger(trigger: string): string {
  const normalized = normalizeText(trigger);
  return normalized ? `trigger: ${normalized.toLowerCase()}` : "";
}

function buildCategory(bundleType: string, previewTone: string): string {
  const typeLabel = humanizeType(bundleType).trim();
  if (typeLabel) return typeLabel.toLowerCase();
  return normalizeText(previewTone).toLowerCase() || "bundle";
}

function buildDescription(options: {
  bundleDescription: string;
  frontmatterDescription: string;
  previewLabel: string;
}): string {
  return truncateAtWordBoundary(
    normalizeText(options.bundleDescription) ||
      normalizeText(options.frontmatterDescription) ||
      normalizeText(options.previewLabel),
    MAX_DESCRIPTION_CHARS,
  );
}

function buildRootOgInput(): OgImageModel {
  return {
    title: "Share OpenWork skills beautifully",
    fileName: "agent-creator.md",
    fileType: "SKILL.md",
    description: "Clean metadata-first social cards for shared OpenWork skills and bundles.",
    category: "share",
    tag: "openwork preview",
    domain: DEFAULT_DOMAIN,
  };
}

function buildBundleOgInput({ rawJson }: { id: string; rawJson: string }): OgImageModel {
  const bundle = parseBundle(rawJson);
  const preview = buildBundlePreview(bundle);
  const { data } = parseFrontmatter(bundle.content);
  const bundleName = maybeString(data.name).trim() || bundle.name || titleFromFileName(preview.filename) || "OpenWork bundle";
  const bundleDescription = maybeString(bundle.description).trim();
  const frontmatterDescription = maybeString(data.description).trim();
  const triggerTag = buildTagFromTrigger(
    maybeString(data.trigger).trim() || maybeString(bundle.trigger).trim(),
  );
  const title =
    bundle.type === "workspace-profile"
      ? "Workspace Profile"
      : bundle.type === "skills-set" && bundle.skills.length > 1
        ? `${bundle.skills.length} Shared Skills`
        : humanizeTitle(bundleName) || "OpenWork bundle";
  const category = buildCategory(bundle.type, preview.tone);
  const tag =
    triggerTag ||
    normalizeText(preview.label).toLowerCase() ||
    `${category} bundle`;

  return {
    title,
    fileName: preview.filename,
    fileType: inferFileType(preview.filename, preview.tone),
    description: buildDescription({
      bundleDescription,
      frontmatterDescription,
      previewLabel: preview.label,
    }),
    category,
    tag,
    domain: DEFAULT_DOMAIN,
  };
}

export function computeOgImageLayout(model: OgImageModel): OgImageLayout {
  const displayTitle = truncateAtWordBoundary(humanizeTitle(model.title) || "OpenWork bundle", MAX_DISPLAY_CHARS);
  const titleTier = getTitleTier(displayTitle.length);
  const config = TITLE_TIER_CONFIG[titleTier];
  const titleLines = splitTextIntoLines(displayTitle, config.charsPerLine, config.maxLines);
  const showDescription = Boolean(model.description) && (titleTier === "xl" || titleTier === "lg");
  const descriptionLines = showDescription
    ? splitTextIntoLines(model.description, 42, 2)
    : [];

  return {
    displayTitle,
    titleTier,
    titleFontSize: config.fontSize,
    titleLineHeight: config.lineHeight,
    titleLines,
    showDescription,
    descriptionLines,
  };
}

function renderOpenWorkMark({ x, y, size }: { x: number; y: number; size: number }): string {
  const dotRadius = size * 0.104;
  const step = size * 0.333;
  const dotOffset = size * 0.1875;

  return `
    <g transform="translate(${x} ${y})">
      <rect width="${size}" height="${size}" rx="${size * 0.25}" fill="#011627" />
      <circle cx="${dotOffset}" cy="${dotOffset}" r="${dotRadius}" fill="#f6f9fc" />
      <circle cx="${dotOffset + step}" cy="${dotOffset}" r="${dotRadius}" fill="#f6f9fc" />
      <circle cx="${dotOffset}" cy="${dotOffset + step}" r="${dotRadius}" fill="#f6f9fc" />
      <circle cx="${dotOffset + step}" cy="${dotOffset + step}" r="${dotRadius}" fill="#f6f9fc" />
    </g>
  `;
}

function renderTitleBlock(model: OgImageModel): string {
  const layout = computeOgImageLayout(model);
  const cardX = 108;
  const cardY = 82;
  const titleWidth = 720;
  const titleX = cardX + 72;
  const descriptionLineHeight = 24;
  const blockHeight =
    layout.titleLines.length * layout.titleLineHeight +
    (layout.showDescription ? layout.descriptionLines.length * descriptionLineHeight + 22 : 0);
  let currentY = cardY + 242 - blockHeight / 2 + layout.titleFontSize;

  const titleMarkup = layout.titleLines
    .map((line, index) => {
      const node = `<text x="${titleX}" y="${currentY + index * layout.titleLineHeight}" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="${layout.titleFontSize}" font-weight="700" letter-spacing="-2">${escapeSvgText(line)}</text>`;
      return node;
    })
    .join("");

  currentY += layout.titleLines.length * layout.titleLineHeight;

  const descriptionMarkup = layout.showDescription
    ? layout.descriptionLines
        .map((line, index) => {
          const y = currentY + 22 + index * descriptionLineHeight;
          return `<text x="${titleX}" y="${y}" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="500">${escapeSvgText(line)}</text>`;
        })
        .join("")
    : "";

  return `
    <clipPath id="title-clip">
      <rect x="${titleX}" y="${cardY + 134}" width="${titleWidth}" height="200" rx="18" />
    </clipPath>
    <g clip-path="url(#title-clip)">
      ${titleMarkup}
      ${descriptionMarkup}
    </g>
  `;
}

function renderSkillCard(model: OgImageModel, variant: OgImageVariant): string {
  const variantConfig = getOgImageVariantConfig(variant);
  const cardX = 108;
  const cardY = 82;
  const cardWidth = 984;
  const cardHeight = 466;
  const badgeWidth = 132;
  const badgeX = cardX + cardWidth - 72 - badgeWidth;
  const badgeY = cardY + 44;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${variantConfig.width}" height="${variantConfig.height}" viewBox="0 0 ${BASE_OG_IMAGE_WIDTH} ${BASE_OG_IMAGE_HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="canvasGradient" x1="72" y1="0" x2="1128" y2="630" gradientUnits="userSpaceOnUse">
      <stop stop-color="#f6f9fc" />
      <stop offset="0.34" stop-color="#edf1f7" />
      <stop offset="0.67" stop-color="#e2e8f0" />
      <stop offset="1" stop-color="#f6f9fc" />
    </linearGradient>
    <linearGradient id="diagonalBand" x1="112" y1="40" x2="1088" y2="590" gradientUnits="userSpaceOnUse">
      <stop offset="0.22" stop-color="#ffffff" stop-opacity="0" />
      <stop offset="0.44" stop-color="#94a3b8" stop-opacity="0.08" />
      <stop offset="0.5" stop-color="#cbd5e1" stop-opacity="0.15" />
      <stop offset="0.56" stop-color="#94a3b8" stop-opacity="0.08" />
      <stop offset="0.78" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
    <pattern id="dotGrid" width="32" height="32" patternUnits="userSpaceOnUse">
      <circle cx="3" cy="3" r="1.2" fill="#94a3b8" fill-opacity="0.18" />
    </pattern>
    <filter id="cardShadow" x="44" y="40" width="1112" height="514" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#011627" flood-opacity="0.08" />
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#011627" flood-opacity="0.04" />
    </filter>
  </defs>
  <rect width="${BASE_OG_IMAGE_WIDTH}" height="${BASE_OG_IMAGE_HEIGHT}" fill="url(#canvasGradient)" />
  <rect x="-180" y="160" width="1560" height="164" transform="rotate(-18 600 315)" fill="url(#diagonalBand)" />
  <rect width="${BASE_OG_IMAGE_WIDTH}" height="${BASE_OG_IMAGE_HEIGHT}" fill="url(#dotGrid)" />

  ${renderOpenWorkMark({ x: 58, y: 30, size: 24 })}
  <text x="92" y="47" fill="#334155" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="600">openwork</text>
  <text x="1012" y="598" fill="#64748b" font-family="JetBrains Mono, Menlo, monospace" font-size="14">${escapeSvgText(model.domain)}</text>

  <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="28" fill="rgba(255,255,255,0.76)" stroke="rgba(226,232,240,0.85)" filter="url(#cardShadow)" />
  <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="28" fill="rgba(255,255,255,0.56)" />

  <text x="${cardX + 72}" y="${cardY + 64}" fill="#64748b" font-family="JetBrains Mono, Menlo, monospace" font-size="18">${escapeSvgText(model.fileName)}</text>

  <g transform="translate(${badgeX} ${badgeY})">
    <rect width="${badgeWidth}" height="34" rx="17" fill="rgba(255,255,255,0.82)" stroke="rgba(226,232,240,0.72)" />
    <circle cx="18" cy="17" r="5" fill="#011627" />
    <text x="31" y="22" fill="#334155" font-family="JetBrains Mono, Menlo, monospace" font-size="15">${escapeSvgText(model.fileType)}</text>
  </g>

  ${renderTitleBlock(model)}

  <text x="${cardX + 72}" y="${cardY + cardHeight - 42}" fill="#64748b" font-family="JetBrains Mono, Menlo, monospace" font-size="15" letter-spacing="2">${escapeSvgText(model.category.toUpperCase())}</text>
  <text x="${cardX + 186}" y="${cardY + cardHeight - 42}" fill="#cbd5e1" font-family="JetBrains Mono, Menlo, monospace" font-size="15">/</text>
  <text x="${cardX + 210}" y="${cardY + cardHeight - 42}" fill="#64748b" font-family="JetBrains Mono, Menlo, monospace" font-size="15">${escapeSvgText(model.tag)}</text>
</svg>`;
}

export function buildRootOgImageModel(): OgImageModel {
  return buildRootOgInput();
}

export function buildBundleOgImageModel({ id, rawJson }: { id: string; rawJson: string }): OgImageModel {
  return buildBundleOgInput({ id, rawJson });
}

export function renderRootOgImage(variant: OgImageVariant = "facebook"): string {
  return renderSkillCard(buildRootOgInput(), variant);
}

export function renderBundleOgImage({
  id,
  rawJson,
  variant = "facebook",
}: {
  id: string;
  rawJson: string;
  variant?: OgImageVariant;
}): string {
  return renderSkillCard(buildBundleOgInput({ id, rawJson }), variant);
}
