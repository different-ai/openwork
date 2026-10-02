import { getMediaBadge } from "@/components/chat/utils";
import { formatAttachmentBytes } from "@/app/lib/v2-prompt-context";

import { humanizeCapabilityName } from "./composer-plus-menu-model";
import { composerConnectorLogoUrls } from "./composer-connector-logos";
import { composerPillTitle, type ComposerPill } from "./composer-pills";

/**
 * How composer chips look. The composer draws them as raw Lexical DOM and the
 * transcript and queue draw them with React; both read this module, so a chip
 * looks the same before and after it is sent.
 *
 * - Badges (skills, agents, connectors, apps, computers, file mentions, pasted
 *   text): one neutral 26px style; only the 18px icon slot carries color.
 * - File chips (non-image attachments): 40px, a 28px type icon, the name, and
 *   the type and size.
 */

type IconElement = readonly [tag: "path" | "rect" | "circle" | "line", attrs: Readonly<Record<string, string>>];

const FILE_OUTLINE: IconElement[] = [
  ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
  ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
];

/** Lucide shapes (24px grid) shared by the DOM and React renderers. */
export const CHIP_ICONS = {
  book: [
    ["path", { d: "M12 7v14" }],
    ["path", { d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" }],
  ],
  file: FILE_OUTLINE,
  "file-text": [...FILE_OUTLINE, ["path", { d: "M10 9H8" }], ["path", { d: "M16 13H8" }], ["path", { d: "M16 17H8" }]],
  "file-image": [...FILE_OUTLINE, ["circle", { cx: "10", cy: "12", r: "2" }], ["path", { d: "m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22" }]],
  "file-sheet": [...FILE_OUTLINE, ["path", { d: "M8 13h2" }], ["path", { d: "M14 13h2" }], ["path", { d: "M8 17h2" }], ["path", { d: "M14 17h2" }]],
  "file-video": [
    ["path", { d: "M4 12V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["path", { d: "m10 17.843 3.033-1.755a.64.64 0 0 1 .967.56v4.704a.65.65 0 0 1-.967.56L10 20.157" }],
    ["rect", { width: "7", height: "6", x: "3", y: "16", rx: "1" }],
  ],
  lines: [["path", { d: "M21 5H3" }], ["path", { d: "M15 12H3" }], ["path", { d: "M17 19H3" }]],
  plug: [
    ["path", { d: "M12 22v-5" }], ["path", { d: "M15 8V2" }], ["path", { d: "M9 8V2" }],
    ["path", { d: "M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z" }],
  ],
  monitor: [["rect", { width: "20", height: "14", x: "2", y: "3", rx: "2" }], ["line", { x1: "8", x2: "16", y1: "21", y2: "21" }], ["line", { x1: "12", x2: "12", y1: "17", y2: "21" }]],
  cloud: [["path", { d: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" }]],
  app: [["rect", { x: "2", y: "4", width: "20", height: "16", rx: "2" }], ["path", { d: "M10 4v4" }], ["path", { d: "M2 8h20" }], ["path", { d: "M6 4v4" }]],
  chevron: [["path", { d: "m9 18 6-6-6-6" }]],
} satisfies Record<string, IconElement[]>;

export type ChipIcon = keyof typeof CHIP_ICONS;

export type BadgeTone = "violet" | "sky" | "cyan" | "gray";

export type ComposerBadge = {
  /** Stable kind, exposed as `data-composer-badge`. */
  kind: "skill" | "connect-skill" | "connector" | "app" | "computer" | "agent" | "file" | "pasted";
  label: string;
  /** Muted detail after the label, e.g. "42 lines". */
  meta?: string;
  title: string;
  tone: BadgeTone;
  slot: { icon: ChipIcon } | { initial: string } | { logoUrls: string[]; fallback: ChipIcon };
  /** Shows a chevron: the badge opens a preview. */
  disclosure?: boolean;
};

export const COMPOSER_BADGE_CLASS = "mx-0.5 inline-flex h-[26px] max-w-[260px] min-w-0 items-center gap-1.5 rounded-lg border border-border bg-background pl-1 pr-2 align-middle text-sm font-medium leading-none text-foreground";
export const COMPOSER_BADGE_SLOT_CLASS = "inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold";
export const COMPOSER_BADGE_LABEL_CLASS = "min-w-0 truncate";
export const COMPOSER_BADGE_META_CLASS = "shrink-0 text-[11px] font-normal text-muted-foreground";
export const COMPOSER_BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  violet: "bg-violet-3 text-violet-11",
  sky: "bg-sky-3 text-sky-11",
  cyan: "bg-cyan-3 text-cyan-11",
  gray: "bg-gray-3 text-gray-11",
};

export const ATTACHMENT_CHIP_CLASS = "inline-flex h-10 max-w-[240px] min-w-0 items-center gap-2 rounded-xl border border-border/70 bg-background pl-1.5 pr-2.5 align-middle text-left";
export const ATTACHMENT_CHIP_ICON_CLASS = "inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-gray-3 text-gray-11";
export const ATTACHMENT_CHIP_NAME_CLASS = "block truncate text-[13px] font-medium leading-4 text-foreground";
export const ATTACHMENT_CHIP_META_CLASS = "block truncate text-[11px] leading-4 text-muted-foreground";

export function composerPillBadge(pill: ComposerPill): ComposerBadge {
  const title = composerPillTitle(pill);
  switch (pill.kind) {
    case "skill":
      return { kind: "skill", label: humanizeCapabilityName(pill.name), title, tone: "violet", slot: { icon: "book" } };
    case "connect-skill":
      return { kind: "connect-skill", label: humanizeCapabilityName(pill.slug), title, tone: "violet", slot: { icon: "book" } };
    case "connector":
      return { kind: "connector", label: pill.name, title, tone: "gray", slot: { logoUrls: composerConnectorLogoUrls({ name: pill.name }), fallback: "plug" } };
    case "app":
      return { kind: "app", label: `@${pill.name}`, title, tone: "cyan", slot: { icon: "app" } };
    case "computer":
      return { kind: "computer", label: `@${pill.target}`, title, tone: "sky", slot: { icon: pill.target === "cloud" ? "cloud" : "monitor" } };
  }
}

export function agentBadge(name: string): ComposerBadge {
  return { kind: "agent", label: name, title: `@${name}`, tone: "sky", slot: { initial: (name.trim()[0] ?? "@").toUpperCase() } };
}

export function fileMentionBadge(path: string): ComposerBadge {
  const name = path.split(/[\\/]/).pop() || path;
  return { kind: "file", label: name, title: path, tone: "gray", slot: { icon: attachmentChipIcon(name, "") } };
}

export function lineCount(text: string): number {
  return text ? text.split(/\r\n|\r|\n/).length : 0;
}

export function pastedTextBadge(lines: number): ComposerBadge {
  return {
    kind: "pasted", label: "Pasted text", meta: `${lines} line${lines === 1 ? "" : "s"}`,
    title: "Pasted text", tone: "gray", slot: { icon: "lines" }, disclosure: true,
  };
}

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "m4v", "avi", "mkv"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"]);
const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "csv", "tsv", "numbers"]);
const TEXT_EXTENSIONS = new Set(["pdf", "doc", "docx", "txt", "md", "markdown", "rtf", "pptx", "json", "html"]);

function extension(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function attachmentChipIcon(filename: string, mime: string): ChipIcon {
  const ext = extension(filename);
  if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) return "file-video";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "file-image";
  if (SHEET_EXTENSIONS.has(ext)) return "file-sheet";
  if (mime.startsWith("text/") || mime === "application/pdf" || TEXT_EXTENSIONS.has(ext)) return "file-text";
  return "file";
}

/** "MP4 · 18.4 MB"; the size is left out when unknown. */
export function attachmentChipMeta(input: { filename: string; mime: string; bytes?: number }): string {
  const type = getMediaBadge({ filename: input.filename, mediaType: input.mime }) ?? "File";
  return input.bytes === undefined ? type : `${type} · ${formatAttachmentBytes(input.bytes)}`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function createChipIconDom(icon: ChipIcon, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: className,
  })) svg.setAttribute(name, value);
  for (const [tag, attrs] of CHIP_ICONS[icon]) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    svg.append(element);
  }
  return svg;
}

function span(className: string, text?: string) {
  const element = document.createElement("span");
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** A logo carries its own color; icons and initials sit on the badge's tone. */
export function composerBadgeSlotClass(badge: ComposerBadge, showsLogo: boolean) {
  return showsLogo ? COMPOSER_BADGE_SLOT_CLASS : `${COMPOSER_BADGE_SLOT_CLASS} ${COMPOSER_BADGE_TONE_CLASS[badge.tone]}`;
}

function createBadgeSlotDom(badge: ComposerBadge) {
  const { slot: content } = badge;
  const logoUrls = "logoUrls" in content ? content.logoUrls : [];
  const slot = span(composerBadgeSlotClass(badge, logoUrls.length > 0));
  if ("initial" in content) {
    slot.textContent = content.initial;
    return slot;
  }
  const icon = "icon" in content ? content.icon : content.fallback;
  if (logoUrls.length === 0) {
    slot.append(createChipIconDom(icon, "size-3"));
    return slot;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.className = "size-3.5 object-contain";
  let attempt = 0;
  img.src = logoUrls[0] ?? "";
  img.addEventListener("error", () => {
    attempt += 1;
    const next = logoUrls[attempt];
    if (next) {
      img.src = next;
      return;
    }
    slot.className = composerBadgeSlotClass(badge, false);
    img.replaceWith(createChipIconDom(icon, "size-3"));
  });
  slot.append(img);
  return slot;
}

/** Fill `dom` with a badge. The composer's Lexical nodes own the outer element. */
export function renderComposerBadgeDom(dom: HTMLElement, badge: ComposerBadge, disclosure?: HTMLElement) {
  dom.className = COMPOSER_BADGE_CLASS;
  dom.title = badge.title;
  dom.dataset.composerBadge = badge.kind;
  dom.replaceChildren(createBadgeSlotDom(badge), span(COMPOSER_BADGE_LABEL_CLASS, badge.label));
  if (badge.meta) dom.append(span(COMPOSER_BADGE_META_CLASS, badge.meta));
  if (disclosure) dom.append(disclosure);
}

/** Fill `dom` with a file chip's icon, name and type. */
export function renderAttachmentFileChipDom(dom: HTMLElement, input: { filename: string; mime: string; bytes?: number }) {
  dom.className = ATTACHMENT_CHIP_CLASS;
  const icon = span(ATTACHMENT_CHIP_ICON_CLASS);
  icon.append(createChipIconDom(attachmentChipIcon(input.filename, input.mime), "size-4"));
  const text = span("min-w-0");
  text.append(span(ATTACHMENT_CHIP_NAME_CLASS, input.filename), span(ATTACHMENT_CHIP_META_CLASS, attachmentChipMeta(input)));
  dom.replaceChildren(icon, text);
}
