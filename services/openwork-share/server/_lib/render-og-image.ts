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

function renderOpenWorkLogo({ x, y, width, height }: { x: number; y: number; width: number; height: number }): string {
  return `
    <svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 1024 866" fill="none">
      <path fill="#257CE9" transform="scale(1.22782 1.22782)" d="M490.962 13.2109C516.808 12.568 530.193 21.0761 551.688 33.1032L589.195 54.1798L626.787 75.2506C636.066 80.4389 649.292 87.5857 657.478 94.0584C671.769 105.914 683.112 124.362 684.683 143.175C685.907 157.831 685.389 173.375 685.377 188.173L685.339 263.964L685.37 354.897C685.391 380.32 686.655 411.29 681.484 435.723C675.249 464.929 662.265 492.269 643.573 515.558C632.659 528.974 618.797 542.079 604.617 552.026C599.568 555.568 592.431 559.221 586.895 562.254L566.235 573.714L489.048 616.153L413.234 657.883C399.18 665.674 384.868 674.248 370.402 681.208C362.127 685.189 352.078 686.881 342.951 687.813C318.706 688.516 306.452 681.909 286.169 670.383L257.958 654.418C241.853 645.558 225.804 636.597 209.812 627.535C198.9 621.412 183.811 613.689 174.536 605.554C158.954 591.701 149.499 572.233 148.244 551.42C147.215 534.843 147.823 512.715 147.821 495.659L147.81 397.552L147.812 317.362C147.82 296.243 146.723 270.836 151.06 250.573C156.911 223.486 169.602 198.349 187.923 177.56C197.018 167.22 207.51 158.199 219.097 150.756C233.391 141.426 253.227 131.448 268.617 123.103L348.755 79.3365L419.409 40.3549C445.897 25.8026 460.025 15.0173 490.962 13.2109ZM350.689 661.215C366.184 656.024 377.335 648.632 391.543 640.597C405.935 632.447 420.396 624.418 434.923 616.51L532.617 563.032C583.215 535.392 616.074 521.904 643.094 467.522C651 451.528 656.046 434.273 658.004 416.539C659.64 401.456 659.102 383.999 659.058 368.652L658.984 301.55L659.114 202.097C659.123 186.04 660.925 148.727 656.309 135.299C653.001 125.621 645.936 117.683 636.707 113.278C630.245 110.188 620.134 107.745 613.008 108.899C604.318 109.655 596.399 112.041 588.722 116.165C577.357 122.269 566.083 128.625 554.759 134.809L476.344 177.842L408.03 215.338C394.874 222.493 377.925 230.923 365.739 238.915C354.985 245.946 345.302 254.493 336.99 264.291C322.261 281.681 312.136 302.494 307.544 324.817C303.925 343.149 305.08 374.437 305.113 394.107L305.183 493.471L305.2 580.911C305.2 596.329 304.599 612.603 305.674 627.933C307.254 650.453 322.586 664.188 344.986 661.954C346.892 661.748 348.793 661.502 350.689 661.215ZM275.046 634.925C276.703 635.884 278.443 636.934 280.128 637.819C278.716 626.741 279.321 604.711 279.333 592.851L279.349 514.659L279.319 397.689L279.307 363.99C279.296 348.799 279.081 336.276 281.868 321.173C286.627 296.026 297.312 272.376 313.038 252.185C322.448 240.062 333.642 229.435 346.238 220.668C358.126 212.437 374.555 203.96 387.566 196.921C405.827 187.071 424.038 177.128 442.198 167.095L540.847 112.798C556.874 103.996 575.722 93.0395 591.788 84.9667L544.597 58.1945C529.914 49.8677 510.295 37.0292 492.825 38.8716C483.01 39.5777 473.292 41.0835 464.415 45.4977C453.156 51.0956 442.077 57.5037 431.036 63.5307L359.332 102.878L282.282 145.173C266.343 153.844 246.398 163.945 231.532 173.678C222.383 179.646 214.109 186.86 206.949 195.111C188.139 216.808 175.15 246.46 173.93 275.291C173.304 290.098 173.676 305.111 173.702 319.948L173.733 400.555L173.754 498.411C173.757 515.471 173.162 532.646 174.011 549.669C174.707 563.612 181.36 577.006 191.74 586.251C200.634 593.773 215.172 601.204 225.649 607.054C242.161 616.261 258.627 625.552 275.046 634.925Z"/>
      <path fill="#257CE9" transform="scale(1.22782 1.22782)" d="M552.454 209.477C572.012 207.959 581.847 219.441 582.39 238.522C582.687 248.987 582.481 259.462 582.458 269.93L582.381 329.269L582.483 374.869C582.513 386.815 582.826 398.849 581.432 410.717C580.03 422.226 576.641 433.405 571.416 443.754C564.818 456.975 555.554 468.686 544.209 478.151C533.954 486.627 522.347 492.2 510.69 498.541L475.758 517.796L441.984 536.419C433.817 540.91 422.997 547.228 414.361 550.139C395.476 554.553 385.023 538.561 385.317 521.594C385.494 511.326 385.526 500.852 385.528 490.583L385.489 419.929L385.431 378.325C385.353 365.955 384.961 352.061 386.603 339.869C388.349 327.707 392.543 316.027 398.933 305.533C412.05 283.666 427.715 275.485 449.348 263.601L480.283 246.56L514.335 227.666C526.451 220.869 538.901 212.844 552.454 209.477ZM411.433 419.84C412.154 444.816 411.109 470.99 411.596 496.052C411.681 500.45 411.062 520.138 411.862 523.514C436.021 509.816 460.32 496.368 484.756 483.172C499.771 474.909 517.93 466.631 530.803 455.318C544.786 443.029 554.756 422.232 555.367 403.682C556.041 383.225 555.895 362.475 555.571 342.046C555.568 341.804 555.455 341.8 555.196 341.71C513.173 364.086 471.908 388.028 429.782 410.228C423.629 413.47 417.693 416.752 411.433 419.84ZM411.24 391.445L414.53 389.48C449.106 371.177 482.45 351.994 516.706 333.189L543.205 318.622C547.228 316.407 553.138 312.877 557.106 311.086C556.18 289.545 557.012 267.818 556.741 246.25C556.699 242.902 557.552 235.271 552.517 234.957C545.074 238.359 537.476 242.917 530.329 246.979C521.218 252.161 512.063 257.266 502.866 262.294L460.839 285.501C451.005 290.952 438.682 297.024 430.234 304.172C423.327 309.962 418.07 317.472 414.993 325.943C409.122 341.857 411.331 373.369 411.24 391.445Z"/>
    </svg>
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

  <text x="1012" y="598" fill="#64748b" font-family="JetBrains Mono, Menlo, monospace" font-size="14">${escapeSvgText(model.domain)}</text>

  <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="28" fill="rgba(255,255,255,0.76)" stroke="rgba(226,232,240,0.85)" filter="url(#cardShadow)" />
  <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="28" fill="rgba(255,255,255,0.56)" />
  ${renderOpenWorkLogo({ x: cardX + 66, y: cardY + 34, width: 40, height: 34 })}

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
