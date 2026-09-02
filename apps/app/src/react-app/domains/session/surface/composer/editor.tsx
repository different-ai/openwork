/** @jsxImportSource react */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type ForwardedRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer.js";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin.js";
import { ContentEditable } from "@lexical/react/LexicalContentEditable.js";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary.js";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin.js";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin.js";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import {
  $applyNodeReplacement,
  $createRangeSelection,
  $createParagraphNode,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $nodesOfType,
  $setSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type SerializedTextNode,
  type Spread,
  TextNode,
  type EditorConfig,
  type NodeKey,
} from "lexical";
import type { InitialConfigType } from "@lexical/react/LexicalComposer.js";
import { decodeComposerMentionValue, encodeComposerMentionValue, type ComposerMentionKind } from "./mention-encoding";
import { parseConnectSkillToken } from "./connect-skill-token";
import { encodeConnectorToken, parseConnectorToken } from "./connector-token";
import { shouldCollapsePastedText, splitPastedText } from "./pasted-text";
import { insertPastedText } from "./pasted-text-insertion";

type PastedTextToken = { label: string; lines: number; text: string };

export type ComposerAttachmentToken = {
  id: string;
  name: string;
  kind: "image" | "file";
  previewUrl?: string;
};

type EditorProps = {
  value: string;
  mentions: Record<string, ComposerMentionKind>;
  pastedText?: PastedTextToken[];
  attachments?: ComposerAttachmentToken[];
  submitDisabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: (options: { queue: boolean }) => void | Promise<void>;
  onExpandPastedText?: (label: string) => void;
  onRemoveAttachment?: (id: string) => void;
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>;
  onPasteText?: (text: string) => void;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDragLeave?: React.DragEventHandler<HTMLDivElement>;
};

export type LexicalPromptEditorHandle = {
  insertSkillAtSelection: (skillName: string, skillToken?: string) => void;
};

type SerializedComposerMentionNode = Spread<
  {
    mentionValue: string;
    mentionKind: ComposerMentionKind;
    type: "composer-mention";
    version: 1;
  },
  SerializedTextNode
>;

type SerializedComposerSlashCommandNode = Spread<
  {
    commandName: string;
    type: "composer-slash-command";
    version: 1;
  },
  SerializedTextNode
>;

type SerializedComposerSkillNode = Spread<
  {
    skillName: string;
    skillToken?: string;
    type: "composer-skill";
    version: 1;
  },
  SerializedTextNode
>;

const MENTION_PILL_CLASS: Record<ComposerMentionKind, string> = {
  computer: "inline-flex items-center rounded-full border border-sky-6/35 bg-sky-3/20 px-2.5 py-1 text-xs font-medium text-sky-11",
  file: "inline-flex items-center rounded-full border border-gray-6 bg-gray-3 px-2.5 py-1 text-xs font-medium text-gray-11",
  agent: "inline-flex items-center rounded-full border border-sky-6/35 bg-sky-3/20 px-2.5 py-1 text-xs font-medium text-sky-11",
  app: "inline-flex items-center rounded-full border border-cyan-6/35 bg-cyan-3/20 px-2.5 py-1 text-xs font-medium text-cyan-11",
};

function mentionPillText(value: string, kind: ComposerMentionKind) {
  return `@${kind === "file" ? value.split(/[\\/]/).pop() || value : value}`;
}

class ComposerMentionNode extends TextNode {
  __value: string;
  __kind: ComposerMentionKind;

  static override getType() {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode) {
    return new ComposerMentionNode(node.__value, node.__kind, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode) {
    return $createComposerMentionNode(serializedNode.mentionValue, serializedNode.mentionKind);
  }

  constructor(value = "", kind: ComposerMentionKind = "file", key?: NodeKey) {
    super(`@${encodeComposerMentionValue(value)}`, key);
    this.__value = value;
    this.__kind = kind;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      mentionValue: this.__value,
      mentionKind: this.__kind,
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig) {
    const dom = document.createElement("span");
    dom.className = MENTION_PILL_CLASS[this.__kind];
    dom.textContent = mentionPillText(this.__value, this.__kind);
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    dom.title = `@${this.__value}`;
    return dom;
  }

  override updateDOM(prevNode: ComposerMentionNode, dom: HTMLElement) {
    if (prevNode.__value !== this.__value || prevNode.__kind !== this.__kind) {
      dom.className = MENTION_PILL_CLASS[this.__kind];
      dom.textContent = mentionPillText(this.__value, this.__kind);
      dom.title = `@${this.__value}`;
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerMentionNode(value: string, kind: ComposerMentionKind) {
  return $applyNodeReplacement(new ComposerMentionNode(value, kind));
}

class ComposerSlashCommandNode extends TextNode {
  __commandName: string;

  static override getType() {
    return "composer-slash-command";
  }

  static override clone(node: ComposerSlashCommandNode) {
    return new ComposerSlashCommandNode(node.__commandName, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSlashCommandNode) {
    return $createComposerSlashCommandNode(serializedNode.commandName);
  }

  constructor(commandName = "", key?: NodeKey) {
    super(`/${commandName}`, key);
    this.__commandName = commandName;
  }

  override exportJSON(): SerializedComposerSlashCommandNode {
    return {
      ...super.exportJSON(),
      commandName: this.__commandName,
      type: "composer-slash-command",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig) {
    const dom = document.createElement("span");
    dom.className = "inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11";
    dom.textContent = `/${this.__commandName}`;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    dom.title = `/${this.__commandName}`;
    return dom;
  }

  override updateDOM(prevNode: ComposerSlashCommandNode, dom: HTMLElement) {
    if (prevNode.__commandName !== this.__commandName) {
      dom.textContent = `/${this.__commandName}`;
      dom.title = `/${this.__commandName}`;
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerSlashCommandNode(commandName: string) {
  return $applyNodeReplacement(new ComposerSlashCommandNode(commandName));
}

class ComposerSkillNode extends TextNode {
  __skillName: string;
  __skillToken: string;

  static override getType() {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode) {
    return new ComposerSkillNode(node.__skillName, node.__skillToken, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode) {
    return $createComposerSkillNode(serializedNode.skillName, serializedNode.skillToken);
  }

  constructor(skillName = "", skillToken?: string, key?: NodeKey) {
    super(skillToken ?? `[skill ${skillName}]`, key);
    this.__skillName = skillName;
    this.__skillToken = skillToken ?? `[skill ${skillName}]`;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      skillToken: this.__skillToken,
      type: "composer-skill",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig) {
    const dom = document.createElement("span");
    dom.className = "inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11";
    dom.textContent = `/${this.__skillName}`;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    dom.title = `Skill: ${this.__skillName}`;
    return dom;
  }

  override updateDOM(prevNode: ComposerSkillNode, dom: HTMLElement) {
    if (prevNode.__skillName !== this.__skillName) {
      dom.textContent = `/${this.__skillName}`;
      dom.title = `Skill: ${this.__skillName}`;
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerSkillNode(skillName: string, skillToken?: string) {
  return $applyNodeReplacement(new ComposerSkillNode(skillName, skillToken));
}

type SerializedComposerConnectorNode = Spread<
  {
    connectorName: string;
    type: "composer-connector";
    version: 1;
  },
  SerializedTextNode
>;

/** `[connector GitHub]` — the connection a seeded prompt is about, shown as a chip. */
class ComposerConnectorNode extends TextNode {
  __connectorName: string;

  static override getType() {
    return "composer-connector";
  }

  static override clone(node: ComposerConnectorNode) {
    return new ComposerConnectorNode(node.__connectorName, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerConnectorNode) {
    return $createComposerConnectorNode(serializedNode.connectorName);
  }

  constructor(connectorName = "", key?: NodeKey) {
    super(encodeConnectorToken(connectorName), key);
    this.__connectorName = connectorName;
  }

  override exportJSON(): SerializedComposerConnectorNode {
    return {
      ...super.exportJSON(),
      connectorName: this.__connectorName,
      type: "composer-connector",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig) {
    const dom = document.createElement("span");
    dom.className = "inline-flex items-center rounded-full border border-blue-6/35 bg-blue-3/20 px-2.5 py-1 text-xs font-medium text-blue-11";
    dom.textContent = this.__connectorName;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    dom.dataset.composerConnector = this.__connectorName;
    dom.title = `Connector: ${this.__connectorName}`;
    return dom;
  }

  override updateDOM(prevNode: ComposerConnectorNode, dom: HTMLElement) {
    if (prevNode.__connectorName !== this.__connectorName) {
      dom.textContent = this.__connectorName;
      dom.dataset.composerConnector = this.__connectorName;
      dom.title = `Connector: ${this.__connectorName}`;
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerConnectorNode(connectorName: string) {
  return $applyNodeReplacement(new ComposerConnectorNode(connectorName));
}

function pastedTextChipLabel(lines: number) {
  return `Pasted · ${lines} line${lines === 1 ? "" : "s"}`;
}

function createPastedTextChipDom(label: string, lines: number) {
  const dom = document.createElement("span");
  dom.className = "inline-flex items-center gap-1 rounded-full border border-amber-6/35 bg-amber-3/15 px-2.5 py-1 text-xs font-medium text-amber-11";
  dom.contentEditable = "false";
  dom.setAttribute("spellcheck", "false");
  dom.title = `Pasted text · ${label}`;

  const text = document.createElement("span");
  text.textContent = pastedTextChipLabel(lines);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ml-1 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-medium text-amber-11 underline decoration-amber-8 underline-offset-2 transition-colors hover:bg-amber-4 hover:text-amber-12";
  button.title = "Expand";
  button.setAttribute("aria-label", "Expand pasted text in composer");
  button.dataset.pastedExpandLabel = label;

  const actionText = document.createElement("span");
  actionText.textContent = "Expand";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "h-3 w-3");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m6 3 5 5-5 5");
  svg.append(path);
  button.append(actionText, svg);
  dom.append(text, button);
  return dom;
}

function updatePastedTextChipDom(dom: HTMLElement, label: string, lines: number) {
  const text = dom.firstElementChild;
  if (text) text.textContent = pastedTextChipLabel(lines);
  const button = dom.querySelector("button[data-pasted-expand-label]");
  if (button instanceof HTMLButtonElement) {
    button.title = "Expand";
    button.setAttribute("aria-label", "Expand pasted text in composer");
    button.dataset.pastedExpandLabel = label;
  }
  dom.title = `Pasted text · ${label}`;
}

type SerializedComposerPastedTextNode = Spread<
  {
    pastedLabel: string;
    pastedLines: number;
    type: "composer-pasted-text";
    version: 1;
  },
  SerializedTextNode
>;

class ComposerPastedTextNode extends TextNode {
  __pastedLabel: string;
  __pastedLines: number;

  static override getType() {
    return "composer-pasted-text";
  }

  static override clone(node: ComposerPastedTextNode) {
    return new ComposerPastedTextNode(node.__pastedLabel, node.__pastedLines, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerPastedTextNode) {
    return $createComposerPastedTextNode(serializedNode.pastedLabel, serializedNode.pastedLines);
  }

  constructor(label = "", lines = 0, key?: NodeKey) {
    super(`[pasted text ${label}]`, key);
    this.__pastedLabel = label;
    this.__pastedLines = lines;
  }

  getPastedLabel() {
    return this.__pastedLabel;
  }

  override exportJSON(): SerializedComposerPastedTextNode {
    return {
      ...super.exportJSON(),
      pastedLabel: this.__pastedLabel,
      pastedLines: this.__pastedLines,
      type: "composer-pasted-text",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig) {
    return createPastedTextChipDom(this.__pastedLabel, this.__pastedLines);
  }

  override updateDOM(prevNode: ComposerPastedTextNode, dom: HTMLElement) {
    if (prevNode.__pastedLabel !== this.__pastedLabel || prevNode.__pastedLines !== this.__pastedLines) {
      updatePastedTextChipDom(dom, this.__pastedLabel, this.__pastedLines);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerPastedTextNode(label: string, lines: number) {
  return $applyNodeReplacement(new ComposerPastedTextNode(label, lines));
}

function createAttachmentChipDom(attachment: ComposerAttachmentToken) {
  const dom = document.createElement("span");
  dom.className = "relative mx-0.5 inline-flex h-10 max-w-[140px] shrink-0 items-center align-middle";
  dom.contentEditable = "false";
  dom.setAttribute("spellcheck", "false");
  dom.title = attachment.name;
  dom.dataset.attachmentId = attachment.id;
  dom.dataset.attachmentStatus = "ready";

  if (attachment.kind === "image" && attachment.previewUrl) {
    const img = document.createElement("img");
    img.src = attachment.previewUrl;
    img.alt = attachment.name;
    img.decoding = "async";
    img.className = "h-10 w-10 rounded-xl border border-border/70 object-cover";
    dom.append(img);
  } else {
    const chip = document.createElement("span");
    chip.className = "inline-flex h-10 max-w-[140px] items-center gap-1.5 rounded-xl border border-border/70 bg-muted/40 px-2";
    const label = document.createElement("span");
    label.className = "truncate text-[11px] font-medium text-foreground";
    label.textContent = attachment.name;
    chip.append(label);
    dom.append(chip);
  }

  // Upload progress overlay: hidden by default, toggled through the chip's
  // data-attachment-status attribute while the draft's attachments are being
  // compressed/uploaded at send time (see syncAttachmentChipStatus).
  const spinner = document.createElement("span");
  spinner.dataset.attachmentSpinner = "true";
  spinner.className = "absolute inset-0 hidden items-center justify-center rounded-xl bg-background/60";
  const spinnerIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  spinnerIcon.setAttribute("viewBox", "0 0 24 24");
  spinnerIcon.setAttribute("fill", "none");
  spinnerIcon.setAttribute("class", "h-4 w-4 animate-spin text-foreground");
  const spinnerArc = document.createElementNS("http://www.w3.org/2000/svg", "path");
  spinnerArc.setAttribute("d", "M12 3a9 9 0 1 0 9 9");
  spinnerArc.setAttribute("stroke", "currentColor");
  spinnerArc.setAttribute("stroke-width", "2.5");
  spinnerArc.setAttribute("stroke-linecap", "round");
  spinnerIcon.append(spinnerArc);
  spinner.append(spinnerIcon);
  dom.append(spinner);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-xs leading-none text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground";
  remove.title = "Remove";
  remove.setAttribute("aria-label", `Remove ${attachment.name}`);
  remove.dataset.attachmentRemoveId = attachment.id;
  remove.textContent = "×";
  dom.append(remove);
  return dom;
}

/**
 * Toggle the uploading overlay on every attachment chip inside `root`.
 * Chips are raw Lexical token DOM (not React), so status is synced by
 * attribute instead of a re-render. Exported for the composer, which flips
 * this while a draft with attachments is being uploaded/sent.
 */
export function syncAttachmentChipStatus(root: HTMLElement, status: "uploading" | "ready") {
  for (const chip of root.querySelectorAll<HTMLElement>("[data-attachment-id]")) {
    chip.dataset.attachmentStatus = status;
    const spinner = chip.querySelector<HTMLElement>("[data-attachment-spinner]");
    if (!spinner) continue;
    spinner.classList.toggle("hidden", status !== "uploading");
    spinner.classList.toggle("flex", status === "uploading");
  }
}

function updateAttachmentChipDom(dom: HTMLElement, attachment: ComposerAttachmentToken) {
  dom.title = attachment.name;
  const remove = dom.querySelector("button[data-attachment-remove-id]");
  if (remove instanceof HTMLButtonElement) {
    remove.dataset.attachmentRemoveId = attachment.id;
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
  }
  const img = dom.querySelector("img");
  if (img instanceof HTMLImageElement && attachment.previewUrl) {
    img.src = attachment.previewUrl;
    img.alt = attachment.name;
  }
  const label = dom.querySelector("span.truncate");
  if (label) label.textContent = attachment.name;
}

type SerializedComposerAttachmentNode = Spread<
  {
    attachmentId: string;
    attachmentName: string;
    attachmentKind: "image" | "file";
    attachmentPreviewUrl?: string;
    type: "composer-attachment";
    version: 1;
  },
  SerializedTextNode
>;

class ComposerAttachmentNode extends TextNode {
  __attachmentId: string;
  __attachmentName: string;
  __attachmentKind: "image" | "file";
  __attachmentPreviewUrl?: string;

  static override getType() {
    return "composer-attachment";
  }

  static override clone(node: ComposerAttachmentNode) {
    return new ComposerAttachmentNode(
      {
        id: node.__attachmentId,
        name: node.__attachmentName,
        kind: node.__attachmentKind,
        previewUrl: node.__attachmentPreviewUrl,
      },
      node.__key,
    );
  }

  static override importJSON(serializedNode: SerializedComposerAttachmentNode) {
    return $createComposerAttachmentNode({
      id: serializedNode.attachmentId,
      name: serializedNode.attachmentName,
      kind: serializedNode.attachmentKind,
      previewUrl: serializedNode.attachmentPreviewUrl,
    });
  }

  constructor(attachment: ComposerAttachmentToken, key?: NodeKey) {
    super(`[attachment ${attachment.id}]`, key);
    this.__attachmentId = attachment.id;
    this.__attachmentName = attachment.name;
    this.__attachmentKind = attachment.kind;
    this.__attachmentPreviewUrl = attachment.previewUrl;
  }

  getAttachmentId() {
    return this.__attachmentId;
  }

  override exportJSON(): SerializedComposerAttachmentNode {
    return {
      ...super.exportJSON(),
      attachmentId: this.__attachmentId,
      attachmentName: this.__attachmentName,
      attachmentKind: this.__attachmentKind,
      attachmentPreviewUrl: this.__attachmentPreviewUrl,
      type: "composer-attachment",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig) {
    return createAttachmentChipDom({
      id: this.__attachmentId,
      name: this.__attachmentName,
      kind: this.__attachmentKind,
      previewUrl: this.__attachmentPreviewUrl,
    });
  }

  override updateDOM(prevNode: ComposerAttachmentNode, dom: HTMLElement) {
    if (
      prevNode.__attachmentId !== this.__attachmentId
      || prevNode.__attachmentName !== this.__attachmentName
      || prevNode.__attachmentKind !== this.__attachmentKind
      || prevNode.__attachmentPreviewUrl !== this.__attachmentPreviewUrl
    ) {
      updateAttachmentChipDom(dom, {
        id: this.__attachmentId,
        name: this.__attachmentName,
        kind: this.__attachmentKind,
        previewUrl: this.__attachmentPreviewUrl,
      });
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerAttachmentNode(attachment: ComposerAttachmentToken) {
  return $applyNodeReplacement(new ComposerAttachmentNode(attachment));
}

type ComposerInlineTokenNode =
  | ComposerMentionNode
  | ComposerSlashCommandNode
  | ComposerSkillNode
  | ComposerConnectorNode
  | ComposerPastedTextNode
  | ComposerAttachmentNode;

function isComposerInlineTokenNode(node: unknown): node is ComposerInlineTokenNode {
  return node instanceof ComposerMentionNode
    || node instanceof ComposerSlashCommandNode
    || node instanceof ComposerSkillNode
    || node instanceof ComposerConnectorNode
    || node instanceof ComposerPastedTextNode
    || node instanceof ComposerAttachmentNode;
}

function setSelectionAfterNode(node: TextNode) {
  const parent = node.getParent();
  if (!parent || !$isElementNode(parent)) return;
  const selection = $createRangeSelection();
  const offset = node.getIndexWithinParent() + 1;
  selection.anchor.set(parent.getKey(), offset, "element");
  selection.focus.set(parent.getKey(), offset, "element");
  $setSelection(selection);
}

function setSelectionBeforeNode(node: ComposerInlineTokenNode) {
  const parent = node.getParent();
  if (!parent || !$isElementNode(parent)) return;
  const selection = $createRangeSelection();
  const offset = node.getIndexWithinParent();
  selection.anchor.set(parent.getKey(), offset, "element");
  selection.focus.set(parent.getKey(), offset, "element");
  $setSelection(selection);
}

function appendSegmentWithNewlines(
  paragraph: ReturnType<typeof $createParagraphNode>,
  segment: string,
) {
  // Preserve newlines in plain text segments. A single paragraph cannot
  // render "\n" as a line break in contenteditable, so we split on "\n"
  // and start a new paragraph per line. Return the paragraph the caller
  // should keep appending to (i.e. the last one we produced).
  if (!segment.includes("\n")) {
    paragraph.append($createTextNode(segment));
    return paragraph;
  }
  const lines = segment.split("\n");
  let current = paragraph;
  lines.forEach((line, index) => {
    if (index > 0) {
      const next = $createParagraphNode();
      current.insertAfter(next);
      current = next;
    }
    if (line.length > 0) {
      current.append($createTextNode(line));
    }
  });
  return current;
}

function setPrompt(
  value: string,
  mentions: Record<string, ComposerMentionKind>,
  pastedText?: PastedTextToken[],
  attachments?: ComposerAttachmentToken[],
) {
  const root = $getRoot();
  root.clear();
  let paragraph = $createParagraphNode();
  root.append(paragraph);

  const slashMatch = value.match(/^\/(\S+)\s(.*)$/s);
  if (slashMatch?.[1]) {
    paragraph.append($createComposerSlashCommandNode(slashMatch[1]));
    paragraph.append($createTextNode(" "));
    value = slashMatch[2] ?? "";
  }

  const segments = value.split(/(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|\[connector [^\]]+\]|@[^\s@]+)/);
  const pastedTextByLabel = new Map((pastedText ?? []).map((item) => [item.label, item]));
  const attachmentsById = new Map((attachments ?? []).map((item) => [item.id, item]));
  for (const segment of segments) {
    if (!segment) continue;
    const connectorName = parseConnectorToken(segment);
    if (connectorName) {
      paragraph.append($createComposerConnectorNode(connectorName));
      continue;
    }
    const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
    if (attachmentMatch?.[1]) {
      const target = attachmentsById.get(attachmentMatch[1]);
      if (target) {
        paragraph.append($createComposerAttachmentNode(target));
        continue;
      }
    }
    const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
    if (pasteMatch?.[1]) {
      const target = pastedTextByLabel.get(pasteMatch[1]);
      if (target) {
        paragraph.append($createComposerPastedTextNode(target.label, target.lines));
        continue;
      }
    }
    const connectSkill = parseConnectSkillToken(segment);
    if (connectSkill) {
      paragraph.append($createComposerSkillNode(connectSkill.slug, segment));
      continue;
    }
    const skillMatch = segment.match(/^\[skill (.+)\]$/);
    if (skillMatch?.[1]) {
      paragraph.append($createComposerSkillNode(skillMatch[1]));
      continue;
    }
    if (segment.startsWith("@")) {
      const token = decodeComposerMentionValue(segment.slice(1));
      const kind = mentions[token];
      if (kind) {
        paragraph.append($createComposerMentionNode(token, kind));
        continue;
      }
    }
    paragraph = appendSegmentWithNewlines(paragraph, segment);
  }
}

function appendSkillAtEnd(skillName: string, skillToken?: string) {
  const root = $getRoot();
  const lastChild = root.getLastChild();
  const paragraph = $isElementNode(lastChild) ? lastChild : $createParagraphNode();
  if (!$isElementNode(lastChild)) root.append(paragraph);
  const skillNode = $createComposerSkillNode(skillName, skillToken);
  const spaceNode = $createTextNode(" ");
  paragraph.append(skillNode, spaceNode);
  setSelectionAfterNode(spaceNode);
}

function insertSkillAtSelection(skillName: string, skillToken?: string) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    appendSkillAtEnd(skillName, skillToken);
    return;
  }
  const skillNode = $createComposerSkillNode(skillName, skillToken);
  const spaceNode = $createTextNode(" ");
  selection.insertNodes([skillNode, spaceNode]);
  setSelectionAfterNode(spaceNode);
}

// Serialize the current editor state to the external draft string. Lexical's
// root.getTextContent() joins element children with "\n\n" (its "text content
// mode" for the root node), which causes single newlines typed/pasted by the
// user to round-trip as double newlines and quickly corrupts the draft. We
// walk root children ourselves and join with a single "\n" so every newline
// the user sees onscreen is preserved exactly in the stored draft.
function serializePromptFromRoot(): string {
  const root = $getRoot();
  return root
    .getChildren()
    .map((child) => child.getTextContent())
    .join("\n");
}

function SyncPlugin(props: {
  value: string;
  mentions: Record<string, ComposerMentionKind>;
  pastedText?: PastedTextToken[];
  attachments?: ComposerAttachmentToken[];
}) {
  const [editor] = useLexicalComposerContext();
  const valueRef = useRef(props.value);

  useEffect(() => {
    // When the external value is cleared (e.g. after sending a message),
    // always force-rebuild the editor to remove any stale chip nodes.
    // The valueRef check can false-positive when both refs converge to ""
    // through different paths (SyncPlugin vs OnChange).
    //
    // NOTE: serializePromptFromRoot() calls $getRoot() which requires an
    // active editor state. Outside of editor.update()/editor.read() we
    // must wrap it in editor.getEditorState().read().
    const currentText = editor.getEditorState().read(() => serializePromptFromRoot());
    const forceRebuild = !props.value.trim() && currentText.trim() !== "";
    if (!forceRebuild && valueRef.current === props.value) return;
    valueRef.current = props.value;
    // Check whether the editor already reflects the desired state BEFORE
    // entering editor.update(). Even a bail-out inside editor.update()
    // triggers Lexical's reconciliation cycle which can normalise the DOM
    // selection and reset the cursor (e.g. after a multi-line paste the
    // cursor jumps to position 0 instead of staying after the pasted
    // content). The read() above already gave us `currentText` — reuse it.
    if (!forceRebuild && currentText === props.value) return;
    editor.update(() => {
      // Double-check inside the update in case another queued update
      // changed the state between the read above and this callback.
      if (!forceRebuild && serializePromptFromRoot() === props.value) return;
      setPrompt(props.value, props.mentions, props.pastedText, props.attachments);
      // $getRoot().selectEnd() doesn't work when the last node is a
      // token (chip) — Lexical can't position a cursor inside a token,
      // so the selection collapses to position 0. Use element-level
      // selection instead: place the cursor *after* the last child of
      // the last paragraph.
      const lastParagraph = $getRoot().getLastChild();
      if ($isElementNode(lastParagraph)) {
        const childCount = lastParagraph.getChildrenSize();
        lastParagraph.select(childCount, childCount);
      } else {
        $getRoot().selectEnd();
      }
    });
  }, [editor, props.attachments, props.mentions, props.pastedText, props.value]);

  return null;
}

function SubmitPlugin(props: { onSubmit: (options: { queue: boolean }) => void | Promise<void>; disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  const onSubmitRef = useRef(props.onSubmit);

  useEffect(() => {
    onSubmitRef.current = props.onSubmit;
  }, [props.onSubmit]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (props.disabled) return false;
        // IME composition guard: three signals keep this reliable across
        // Chrome, Safari, and WebKit. While IME is mid-character, Enter
        // must always fall through to the editor so the composition can
        // commit.
        if (event?.isComposing === true || event?.keyCode === 229) return false;
        // Shift+Enter inserts a newline — let the editor handle it.
        if (event?.shiftKey) return false;
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        // Plain Enter submits. Cmd/Ctrl+Enter is the modifier: while the
        // agent is busy, Enter queues and the modifier steers.
        event?.preventDefault();
        void onSubmitRef.current({ queue: event?.metaKey === true || event?.ctrlKey === true });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, props.disabled]);

  return null;
}

function appendPastedTextMeasurement(element: HTMLElement, text: string) {
  const paragraph = document.createElement("p");
  for (const segment of splitPastedText(text)) {
    if (segment.kind === "line-break") {
      paragraph.append(document.createElement("br"));
    } else if (segment.kind === "tab") {
      paragraph.append(document.createTextNode("\t"));
    } else {
      paragraph.append(document.createTextNode(segment.text));
    }
  }
  element.append(paragraph);
}

function pastedTextWouldOverflowEditor(text: string, editorElement: HTMLElement | null) {
  if (!editorElement) return false;
  const bounds = editorElement.getBoundingClientRect();
  if (bounds.width <= 0) return false;

  const measurement = editorElement.cloneNode(false);
  if (!(measurement instanceof HTMLElement)) return false;
  measurement.setAttribute("aria-hidden", "true");
  measurement.style.position = "fixed";
  measurement.style.left = "-10000px";
  measurement.style.top = "0";
  measurement.style.width = `${bounds.width}px`;
  measurement.style.height = "auto";
  measurement.style.minHeight = "0";
  measurement.style.visibility = "hidden";
  measurement.style.pointerEvents = "none";
  appendPastedTextMeasurement(measurement, text);
  document.body.append(measurement);

  try {
    return measurement.scrollHeight > measurement.clientHeight;
  } finally {
    measurement.remove();
  }
}

function PasteChipPlugin(props: { onPasteText?: (text: string) => void }) {
  const [editor] = useLexicalComposerContext();
  const onPasteTextRef = useRef(props.onPasteText);

  useEffect(() => {
    onPasteTextRef.current = props.onPasteText;
  }, [props.onPasteText]);

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        if (event.defaultPrevented) return false;
        // Only handle plain-text pastes; files and URI lists are handled in the React onPaste.
        const files = event.clipboardData?.files;
        if (files && files.length > 0) return false;
        if (event.clipboardData?.getData("text/uri-list").trim()) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text.trim()) return false;
        const wouldOverflowComposer = pastedTextWouldOverflowEditor(text, editor.getRootElement());
        if (shouldCollapsePastedText(text, wouldOverflowComposer)) {
          if (!onPasteTextRef.current) return false;
          event.preventDefault();
          onPasteTextRef.current(text);
          return true;
        }
        event.preventDefault();
        return insertPastedText(text);
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor]);

  return null;
}

function pastedExpandButton(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const button = target.closest("button[data-pasted-expand-label]");
  return button instanceof HTMLButtonElement ? button : null;
}

function replacePastedTextChip(label: string, text: string, button: HTMLButtonElement) {
  const nearest = $getNearestNodeFromDOMNode(button);
  if (nearest instanceof ComposerPastedTextNode && nearest.getPastedLabel() === label) {
    nearest.select(0, nearest.getTextContentSize());
    return insertPastedText(text);
  }
  for (const node of $nodesOfType(ComposerPastedTextNode)) {
    if (node.getPastedLabel() !== label) continue;
    node.select(0, node.getTextContentSize());
    return insertPastedText(text);
  }
  return false;
}

function PastedTextExpandPlugin(props: { pastedText?: PastedTextToken[]; onExpandPastedText?: (label: string) => void }) {
  const [editor] = useLexicalComposerContext();
  const pastedTextRef = useRef(props.pastedText);
  const onExpandPastedTextRef = useRef(props.onExpandPastedText);

  useEffect(() => {
    pastedTextRef.current = props.pastedText;
    onExpandPastedTextRef.current = props.onExpandPastedText;
  }, [props.onExpandPastedText, props.pastedText]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (!pastedExpandButton(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleClick = (event: MouseEvent) => {
      const button = pastedExpandButton(event.target);
      if (!button) return;
      const label = button.dataset.pastedExpandLabel;
      if (!label) return;
      event.preventDefault();
      event.stopPropagation();
      const target = pastedTextRef.current?.find((item) => item.label === label);
      if (target) {
        editor.update(() => {
          replacePastedTextChip(label, target.text, button);
        });
      }
      onExpandPastedTextRef.current?.(label);
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("mousedown", handleMouseDown, true);
      previousRootElement?.removeEventListener("click", handleClick, true);
      rootElement?.addEventListener("mousedown", handleMouseDown, true);
      rootElement?.addEventListener("click", handleClick, true);
    });
  }, [editor]);

  return null;
}

function MentionChipNavigationPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
        const anchorNode = selection.anchor.getNode();

        // --- Slash command chip: atomic delete ---
        // When cursor is in the text node right after a slash chip,
        // remove the chip (and any trailing whitespace text) in one action.
        if ($isTextNode(anchorNode)) {
          const previous = anchorNode.getPreviousSibling();
          if (previous instanceof ComposerSlashCommandNode) {
            // At offset 0: cursor is right after the chip -> remove chip
            // At offset > 0 but text is only whitespace: also remove chip
            const textBefore = anchorNode.getTextContent().slice(0, selection.anchor.offset);
            if (selection.anchor.offset === 0 || textBefore.trim() === "") {
              previous.remove();
              // Also remove the whitespace-only prefix
              if (selection.anchor.offset > 0) {
                const remaining = anchorNode.getTextContent().slice(selection.anchor.offset);
                if (remaining) {
                  anchorNode.setTextContent(remaining);
                  const sel = $createRangeSelection();
                  sel.anchor.set(anchorNode.getKey(), 0, "text");
                  sel.focus.set(anchorNode.getKey(), 0, "text");
                  $setSelection(sel);
                } else {
                  anchorNode.remove();
                }
              }
              return true;
            }
          }
        }

        // --- Mention / pasted-text / attachment chips: atomic delete ---
        if ($isTextNode(anchorNode) && selection.anchor.offset === 0) {
          const previous = anchorNode.getPreviousSibling();
          if (isComposerInlineTokenNode(previous) && !(previous instanceof ComposerSlashCommandNode)) {
            previous.remove();
            return true;
          }
        }

        if ($isElementNode(anchorNode)) {
          const previous = anchorNode.getChildAtIndex(selection.anchor.offset - 1);
          if (isComposerInlineTokenNode(previous)) {
            previous.remove();
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
        const anchorNode = selection.anchor.getNode();

        if ($isTextNode(anchorNode) && selection.anchor.offset === 0) {
          const previous = anchorNode.getPreviousSibling();
          if (isComposerInlineTokenNode(previous)) {
            setSelectionBeforeNode(previous);
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
        const anchorNode = selection.anchor.getNode();

        if (isComposerInlineTokenNode(anchorNode)) {
          setSelectionAfterNode(anchorNode);
          return true;
        }

        if ($isElementNode(anchorNode)) {
          const current = anchorNode.getChildAtIndex(selection.anchor.offset);
          if (isComposerInlineTokenNode(current)) {
            setSelectionAfterNode(current);
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterBackspace();
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

function ImperativeHandlePlugin(props: { editorRef: ForwardedRef<LexicalPromptEditorHandle> }) {
  const [editor] = useLexicalComposerContext();

  useImperativeHandle(props.editorRef, () => ({
    insertSkillAtSelection(skillName: string, skillToken?: string) {
      editor.update(() => insertSkillAtSelection(skillName, skillToken));
      editor.focus();
    },
  }), [editor]);

  return null;
}

function attachmentRemoveButton(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const button = target.closest("button[data-attachment-remove-id]");
  return button instanceof HTMLButtonElement ? button : null;
}

function AttachmentRemovePlugin(props: { onRemoveAttachment?: (id: string) => void }) {
  const [editor] = useLexicalComposerContext();
  const onRemoveAttachmentRef = useRef(props.onRemoveAttachment);

  useEffect(() => {
    onRemoveAttachmentRef.current = props.onRemoveAttachment;
  }, [props.onRemoveAttachment]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (!attachmentRemoveButton(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleClick = (event: MouseEvent) => {
      const button = attachmentRemoveButton(event.target);
      if (!button) return;
      const id = button.dataset.attachmentRemoveId;
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      onRemoveAttachmentRef.current?.(id);
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("mousedown", handleMouseDown, true);
      previousRootElement?.removeEventListener("click", handleClick, true);
      rootElement?.addEventListener("mousedown", handleMouseDown, true);
      rootElement?.addEventListener("click", handleClick, true);
    });
  }, [editor]);

  return null;
}

export const LexicalPromptEditor = forwardRef<LexicalPromptEditorHandle, EditorProps>(function LexicalPromptEditor(props, ref) {
  const valueRef = useRef(props.value);
  const onChangeRef = useRef(props.onChange);

  useEffect(() => {
    valueRef.current = props.value;
  }, [props.value]);

  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  const initialConfig = useMemo(
    () => ({
      namespace: "openwork-react-session-composer",
      onError(error: Error) {
        throw error;
      },
      editable: true,
      nodes: [ComposerMentionNode, ComposerSlashCommandNode, ComposerSkillNode, ComposerConnectorNode, ComposerPastedTextNode, ComposerAttachmentNode],
      editorState: () => {
        setPrompt(props.value, props.mentions, props.pastedText, props.attachments);
      },
    }),
    [],
  );

  const syncPromptFromEditorState = useCallback(
    (state: Parameters<NonNullable<React.ComponentProps<typeof OnChangePlugin>["onChange"]>>[0]) => {
      state.read(() => {
        const next = serializePromptFromRoot();
        if (next === valueRef.current) return;
        valueRef.current = next;
        onChangeRef.current(next);
      });
    },
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      {/*
        Tight start, bounded growth:
        - min-h holds the editor to a single-line look until the user starts typing.
        - max-h caps the composer — long pastes / multi-paragraph drafts scroll
          inside the editor instead of pushing the transcript out of view.
      */}
      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="min-h-[60px] max-h-[280px] w-full resize-none overflow-y-auto bg-transparent text-base leading-6 text-dls-text outline-none placeholder:text-dls-secondary lg:text-[13px] lg:leading-[1.55] [&_p]:min-h-[1.5rem] [&_p]:m-0"
              aria-placeholder={props.placeholder}
              placeholder={<span />}
              onPaste={props.onPaste}
              onDrop={props.onDrop}
              onDragOver={props.onDragOver}
              onDragLeave={props.onDragLeave}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-0 top-0 text-base leading-6 text-dls-secondary/70 lg:text-[13px] lg:leading-[1.55]">
              {props.placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={syncPromptFromEditorState} />
        <HistoryPlugin />
        <SyncPlugin
          value={props.value}
          mentions={props.mentions}
          pastedText={props.pastedText}
          attachments={props.attachments}
        />
        <SubmitPlugin onSubmit={props.onSubmit} disabled={props.submitDisabled} />
        <PasteChipPlugin onPasteText={props.onPasteText} />
        <PastedTextExpandPlugin pastedText={props.pastedText} onExpandPastedText={props.onExpandPastedText} />
        <AttachmentRemovePlugin onRemoveAttachment={props.onRemoveAttachment} />
        <MentionChipNavigationPlugin />
        <ImperativeHandlePlugin editorRef={ref} />
      </div>
    </LexicalComposer>
  );
});
