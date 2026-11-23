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
  $getNodeByKey,
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
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type SerializedTextNode,
  type Spread,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
} from "lexical";
import type { InitialConfigType } from "@lexical/react/LexicalComposer.js";
import { decodeComposerMentionValue, encodeComposerMentionValue, type ComposerMentionKind } from "./mention-encoding";
import { encodeConnectorToken } from "./connector-token";
import { COMPOSER_DRAFT_TOKEN_RE, COMPOSER_TOKEN_CLASS, parseComposerPillToken, type ComposerPill } from "./composer-pills";
import {
  agentBadge,
  composerPillBadge,
  createChipIconDom,
  fileMentionBadge,
  pastedTextBadge,
  renderAttachmentFileChipDom,
  renderComposerBadgeDom,
  sessionReferenceBadge,
  type ComposerBadge,
} from "./composer-chips";
import {
  encodeSessionReferenceToken,
  type SessionReferenceTokenValue,
} from "./session-reference-token";
import { isComputerTarget } from "./computer-mentions";
import { shouldCollapsePastedText, splitPastedText } from "./pasted-text";
import { insertPastedText } from "./pasted-text-insertion";
import { lineBoundaryMoveForKey } from "./line-boundary-keys";
import { inlineMentionAtCaret, type MentionTrigger } from "./mention-suggestions";
import { slashTriggerAtCaret, type SlashTrigger } from "./slash-command";

type PastedTextToken = { label: string; lines: number; text: string };

export type ComposerAttachmentToken = {
  id: string;
  name: string;
  kind: "image" | "file";
  previewUrl?: string;
  mime?: string;
  bytes?: number;
};

type EditorProps = {
  value: string;
  mentions: Record<string, ComposerMentionKind>;
  pastedText?: PastedTextToken[];
  attachments?: ComposerAttachmentToken[];
  submitDisabled: boolean;
  placeholder: string;
  placeholderShortcut?: string;
  onChange: (value: string) => void;
  onInlineMentionChange?: (trigger: MentionTrigger | null) => void;
  onMentionQueryChange?: (query: string | null) => void;
  onSlashQueryChange?: (trigger: SlashTrigger | null) => void;
  onSessionReferenceQueryChange?: (trigger: { query: string; offset: number } | null) => void;
  onOpenSessionReference?: (reference: { workspaceId: string; sessionId: string }) => void;
  onSubmit: (options: { queue: boolean }) => void | Promise<void>;
  onExpandPastedText?: (label: string) => void;
  onExpandAttachment?: (id: string) => void;
  onRemoveAttachment?: (id: string) => void;
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>;
  onPasteText?: (text: string, draftOffset?: number) => void;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDragLeave?: React.DragEventHandler<HTMLDivElement>;
};

export type LexicalPromptEditorHandle = {
  replaceSlashAtSelection: (trigger: SlashTrigger, choice: { kind: "command"; name: string } | { kind: "skill"; name: string; token?: string }) => boolean;
  insertSkillAtSelection: (skillName: string, skillToken?: string) => void;
  insertMentionAtSelection: (kind: ComposerMentionKind, value: string, inline?: boolean) => string | null;
  insertConnectorAtSelection: (connectorName: string) => void;
  insertSessionReferenceAtSelection: (reference: SessionReferenceTokenValue, inline?: boolean) => string | null;
  insertFileMentionAtSelection: (path: string) => string;
  draftOffsetAtSelection: () => number | null;
  draftSelectionRange: () => { start: number; end: number } | null;
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

function mentionBadge(value: string, kind: ComposerMentionKind): ComposerBadge {
  switch (kind) {
    case "agent":
      return agentBadge(value);
    case "file":
      return fileMentionBadge(value);
    case "computer":
      return isComputerTarget(value) ? composerPillBadge({ kind: "computer", target: value }) : agentBadge(value);
  }
}

function renderMentionDom(dom: HTMLElement, value: string, kind: ComposerMentionKind) {
  renderComposerBadgeDom(dom, mentionBadge(value, kind));
  dom.title = `@${value}`;
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
    renderMentionDom(dom, this.__value, this.__kind);
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    return dom;
  }

  override updateDOM(prevNode: ComposerMentionNode, dom: HTMLElement) {
    if (prevNode.__value !== this.__value || prevNode.__kind !== this.__kind) {
      renderMentionDom(dom, this.__value, this.__kind);
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
    dom.className = COMPOSER_TOKEN_CLASS;
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

function skillNodePill(name: string, token: string): ComposerPill {
  const pill = parseComposerPillToken(token);
  return pill?.kind === "connect-skill" || pill?.kind === "skill" ? pill : { kind: "skill", name };
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
    renderComposerBadgeDom(dom, composerPillBadge(skillNodePill(this.__skillName, this.__skillToken)));
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    return dom;
  }

  override updateDOM(prevNode: ComposerSkillNode, dom: HTMLElement) {
    if (prevNode.__skillName !== this.__skillName || prevNode.__skillToken !== this.__skillToken) {
      renderComposerBadgeDom(dom, composerPillBadge(skillNodePill(this.__skillName, this.__skillToken)));
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
    renderComposerBadgeDom(dom, composerPillBadge({ kind: "connector", name: this.__connectorName }));
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    dom.dataset.composerConnector = this.__connectorName;
    return dom;
  }

  override updateDOM(prevNode: ComposerConnectorNode, dom: HTMLElement) {
    if (prevNode.__connectorName !== this.__connectorName) {
      renderComposerBadgeDom(dom, composerPillBadge({ kind: "connector", name: this.__connectorName }));
      dom.dataset.composerConnector = this.__connectorName;
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

type SerializedComposerSessionReferenceNode = Spread<
  {
    workspaceId: string;
    sessionId: string;
    sessionTitle: string;
    type: "composer-session-reference";
    version: 1;
  },
  SerializedTextNode
>;

function renderSessionReferenceDom(dom: HTMLElement, value: SessionReferenceTokenValue) {
  renderComposerBadgeDom(dom, sessionReferenceBadge(value.title));
  dom.classList.add("cursor-pointer", "hover:bg-accent");
  dom.title = `Open task: ${value.title || value.sessionId}`;
  dom.setAttribute("role", "link");
  dom.setAttribute("aria-label", `Open task: ${value.title || value.sessionId}`);
  dom.dataset.sessionReferenceWorkspace = value.workspaceId;
  dom.dataset.sessionReferenceSession = value.sessionId;
}

class ComposerSessionReferenceNode extends TextNode {
  __reference: SessionReferenceTokenValue;

  static override getType() {
    return "composer-session-reference";
  }

  static override clone(node: ComposerSessionReferenceNode) {
    return new ComposerSessionReferenceNode(node.__reference, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSessionReferenceNode) {
    return $createComposerSessionReferenceNode({
      workspaceId: serializedNode.workspaceId,
      sessionId: serializedNode.sessionId,
      title: serializedNode.sessionTitle,
    });
  }

  constructor(reference: SessionReferenceTokenValue = { workspaceId: "", sessionId: "", title: "" }, key?: NodeKey) {
    super(encodeSessionReferenceToken(reference) ?? "", key);
    this.__reference = reference;
  }

  override exportJSON(): SerializedComposerSessionReferenceNode {
    return {
      ...super.exportJSON(),
      workspaceId: this.__reference.workspaceId,
      sessionId: this.__reference.sessionId,
      sessionTitle: this.__reference.title,
      type: "composer-session-reference",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig) {
    const dom = document.createElement("span");
    renderSessionReferenceDom(dom, this.__reference);
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    return dom;
  }

  override updateDOM(prevNode: ComposerSessionReferenceNode, dom: HTMLElement) {
    const prev = prevNode.__reference;
    const next = this.__reference;
    if (prev.workspaceId !== next.workspaceId || prev.sessionId !== next.sessionId || prev.title !== next.title) {
      renderSessionReferenceDom(dom, next);
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

function $createComposerSessionReferenceNode(reference: SessionReferenceTokenValue) {
  return $applyNodeReplacement(new ComposerSessionReferenceNode(reference));
}

function renderPastedTextChipDom(dom: HTMLElement, label: string, lines: number) {
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "-mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-gray-3 hover:text-foreground";
  expand.title = "Expand";
  expand.setAttribute("aria-label", "Expand pasted text in composer");
  expand.dataset.pastedExpandLabel = label;
  expand.append(createChipIconDom("chevron", "size-3"));
  renderComposerBadgeDom(dom, pastedTextBadge(lines), expand);
  dom.title = `Pasted text · ${label}`;
}

function createPastedTextChipDom(label: string, lines: number) {
  const dom = document.createElement("span");
  dom.contentEditable = "false";
  dom.setAttribute("spellcheck", "false");
  renderPastedTextChipDom(dom, label, lines);
  return dom;
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
      renderPastedTextChipDom(dom, this.__pastedLabel, this.__pastedLines);
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
  dom.className = "relative mx-0.5 inline-flex h-10 max-w-[240px] shrink-0 items-center align-middle";
  dom.contentEditable = "false";
  dom.setAttribute("spellcheck", "false");
  dom.title = attachment.name;
  dom.dataset.attachmentId = attachment.id;
  dom.dataset.attachmentStatus = "ready";

  if (attachment.kind === "image" && attachment.previewUrl) {
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "h-10 w-10 cursor-zoom-in overflow-hidden rounded-xl border border-border/70 transition-opacity hover:opacity-90";
    expand.setAttribute("aria-label", `Expand ${attachment.name}`);
    expand.dataset.attachmentExpandId = attachment.id;
    const img = document.createElement("img");
    img.src = attachment.previewUrl;
    img.alt = attachment.name;
    img.decoding = "async";
    img.className = "h-full w-full object-cover";
    expand.append(img);
    dom.append(expand);
  } else {
    const chip = document.createElement("span");
    chip.dataset.attachmentFileChip = "true";
    renderAttachmentFileChipDom(chip, { filename: attachment.name, mime: attachment.mime ?? "", bytes: attachment.bytes });
    dom.append(chip);
  }

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
  const expand = dom.querySelector("button[data-attachment-expand-id]");
  if (expand instanceof HTMLButtonElement) {
    expand.dataset.attachmentExpandId = attachment.id;
    expand.setAttribute("aria-label", `Expand ${attachment.name}`);
  }
  const img = dom.querySelector("img");
  if (img instanceof HTMLImageElement && attachment.previewUrl) {
    img.src = attachment.previewUrl;
    img.alt = attachment.name;
  }
  const chip = dom.querySelector<HTMLElement>("[data-attachment-file-chip]");
  if (chip) renderAttachmentFileChipDom(chip, { filename: attachment.name, mime: attachment.mime ?? "", bytes: attachment.bytes });
}

type SerializedComposerAttachmentNode = Spread<
  {
    attachmentId: string;
    attachmentName: string;
    attachmentKind: "image" | "file";
    attachmentPreviewUrl?: string;
    attachmentMime?: string;
    attachmentBytes?: number;
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
  __attachmentMime?: string;
  __attachmentBytes?: number;

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
        mime: node.__attachmentMime,
        bytes: node.__attachmentBytes,
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
      mime: serializedNode.attachmentMime,
      bytes: serializedNode.attachmentBytes,
    });
  }

  constructor(attachment: ComposerAttachmentToken, key?: NodeKey) {
    super(`[attachment ${attachment.id}]`, key);
    this.__attachmentId = attachment.id;
    this.__attachmentName = attachment.name;
    this.__attachmentKind = attachment.kind;
    this.__attachmentPreviewUrl = attachment.previewUrl;
    this.__attachmentMime = attachment.mime;
    this.__attachmentBytes = attachment.bytes;
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
      attachmentMime: this.__attachmentMime,
      attachmentBytes: this.__attachmentBytes,
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
      mime: this.__attachmentMime,
      bytes: this.__attachmentBytes,
    });
  }

  override updateDOM(prevNode: ComposerAttachmentNode, dom: HTMLElement) {
    if (
      prevNode.__attachmentId !== this.__attachmentId
      || prevNode.__attachmentName !== this.__attachmentName
      || prevNode.__attachmentKind !== this.__attachmentKind
      || prevNode.__attachmentPreviewUrl !== this.__attachmentPreviewUrl
      || prevNode.__attachmentMime !== this.__attachmentMime
      || prevNode.__attachmentBytes !== this.__attachmentBytes
    ) {
      updateAttachmentChipDom(dom, {
        id: this.__attachmentId,
        name: this.__attachmentName,
        kind: this.__attachmentKind,
        previewUrl: this.__attachmentPreviewUrl,
        mime: this.__attachmentMime,
        bytes: this.__attachmentBytes,
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
  | ComposerSessionReferenceNode
  | ComposerPastedTextNode
  | ComposerAttachmentNode;

function isComposerInlineTokenNode(node: unknown): node is ComposerInlineTokenNode {
  return node instanceof ComposerMentionNode
    || node instanceof ComposerSlashCommandNode
    || node instanceof ComposerSkillNode
    || node instanceof ComposerConnectorNode
    || node instanceof ComposerSessionReferenceNode
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

  const segments = value.split(COMPOSER_DRAFT_TOKEN_RE);
  const pastedTextByLabel = new Map((pastedText ?? []).map((item) => [item.label, item]));
  const attachmentsById = new Map((attachments ?? []).map((item) => [item.id, item]));
  for (const segment of segments) {
    if (!segment) continue;
    const pill = parseComposerPillToken(segment);
    if (pill?.kind === "connector") {
      paragraph.append($createComposerConnectorNode(pill.name));
      continue;
    }
    if (pill?.kind === "session") {
      paragraph.append($createComposerSessionReferenceNode(pill));
      continue;
    }
    if (pill?.kind === "connect-skill") {
      paragraph.append($createComposerSkillNode(pill.slug, segment));
      continue;
    }
    if (pill?.kind === "skill") {
      paragraph.append($createComposerSkillNode(pill.name));
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

const TRIGGER_QUERY_RE = {
  "@": { before: /(?<!\S)@([^\s@]*)$/, after: /^[^\s@]*/ },
  "#": { before: /(?<!\S)#((?:[^\s#][^#\n]*)?)$/, after: /^[^\s#]*/ },
} as const;

function editableTextAtSelection() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  let node = selection.anchor.getNode();
  let end = selection.anchor.offset;
  if ($isElementNode(node)) {
    const previous = node.getChildAtIndex(end - 1);
    if (!$isTextNode(previous)) return null;
    node = previous;
    end = node.getTextContentSize();
  }
  if (!$isTextNode(node) || isComposerInlineTokenNode(node)) return null;
  return { node, caret: end };
}

function triggerQueryAtSelection(trigger: keyof typeof TRIGGER_QUERY_RE) {
  const point = editableTextAtSelection();
  if (!point) return null;
  const { node, caret: end } = point;
  const text = node.getTextContent();
  const patterns = TRIGGER_QUERY_RE[trigger];
  const match = text.slice(0, end).match(patterns.before);
  if (!match) return null;
  const remaining = text.slice(end).match(patterns.after)?.[0] ?? "";
  return { node, start: end - match[0].length, end: end + remaining.length, caret: end, query: match[1] ?? "" };
}

function inlineTriggerAtSelection<T extends { query: string; offset: number; end: number }>(find: (text: string, caret: number) => T | null) {
  const point = editableTextAtSelection();
  const caret = $draftOffsetAtSelection();
  if (!point || caret === null) return null;
  const { node } = point;
  const boundary = node.getPreviousSibling()?.getTextContent().slice(-1) ?? "";
  const match = find(boundary + node.getTextContent(), boundary.length + point.caret);
  if (!match || match.offset < boundary.length) return null;
  const start = match.offset - boundary.length;
  return { node, start, end: match.end - boundary.length, boundaryLength: boundary.length, match, trigger: { query: match.query, offset: caret - (point.caret - start) } };
}

function slashAtSelection() {
  return inlineTriggerAtSelection(slashTriggerAtCaret);
}

function inlineMentionAtSelection() {
  return inlineTriggerAtSelection(inlineMentionAtCaret);
}

function mentionAtSelection() {
  return triggerQueryAtSelection("@");
}

function sessionReferenceQueryAtSelection() {
  return triggerQueryAtSelection("#");
}

function sessionReferenceTriggerAtSelection() {
  const match = sessionReferenceQueryAtSelection();
  if (!match) return null;
  const caret = $draftOffsetAtSelection();
  return { query: match.query, offset: caret === null ? -1 : caret - (match.caret - match.start) };
}

function insertSessionReferenceAtSelection(reference: SessionReferenceTokenValue, inline: boolean) {
  const match = inline ? inlineMentionAtSelection() : sessionReferenceQueryAtSelection();
  if (!match || !encodeSessionReferenceToken(reference)) return false;
  const end = match.end + (match.node.getTextContent()[match.end] === " " ? 1 : 0);
  const selection = match.node.select(match.start, end);
  const chip = $createComposerSessionReferenceNode(reference);
  const space = $createTextNode(" ");
  selection.insertNodes([chip, space]);
  space.selectEnd();
  return true;
}

function insertMentionAtSelection(kind: ComposerMentionKind, value: string, inline: boolean) {
  const inlineMatch = inline ? inlineMentionAtSelection() : null;
  const match = inline ? inlineMatch : mentionAtSelection();
  if (!match) return false;
  const wordEnd = inlineMatch ? inlineMatch.match.firstWordEnd - inlineMatch.boundaryLength : match.end;
  const end = wordEnd + (kind !== "agent" && match.node.getTextContent()[wordEnd] === " " ? 1 : 0);
  const selection = match.node.select(match.start, end);
  if (kind === "agent") {
    selection.removeText();
    return true;
  }
  const mention = $createComposerMentionNode(value, kind);
  const space = $createTextNode(" ");
  selection.insertNodes([mention, space]);
  space.selectEnd();
  return true;
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

function insertTokenAtSelection(tokenNode: TextNode) {
  const spaceNode = $createTextNode(" ");
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    const root = $getRoot();
    const lastChild = root.getLastChild();
    const paragraph = $isElementNode(lastChild) ? lastChild : $createParagraphNode();
    if (!$isElementNode(lastChild)) root.append(paragraph);
    paragraph.append(tokenNode, spaceNode);
  } else {
    selection.insertNodes([tokenNode, spaceNode]);
  }
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

function serializePromptFromRoot(): string {
  const root = $getRoot();
  return root
    .getChildren()
    .map((child) => child.getTextContent())
    .join("\n");
}

function $draftOffsetAtSelection(edge: "start" | "end" = "start"): number | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const point = edge === "start"
    ? selection.isBackward() ? selection.focus : selection.anchor
    : selection.isBackward() ? selection.anchor : selection.focus;
  const node = point.getNode();
  const paragraphs = $getRoot().getChildren();
  const before = (nodes: LexicalNode[]) => nodes.reduce((sum, child) => sum + child.getTextContentSize(), 0);
  if (node.is($getRoot())) return before(paragraphs.slice(0, point.offset)) + point.offset;
  const paragraph = node.getTopLevelElement();
  if (!paragraph) return null;
  const index = paragraphs.findIndex((child) => child.is(paragraph));
  let offset = before(paragraphs.slice(0, index)) + index;
  if (node.is(paragraph) && $isElementNode(paragraph)) return offset + before(paragraph.getChildren().slice(0, point.offset));
  offset += before(node.getPreviousSiblings());
  if (!$isTextNode(node)) return offset;
  return offset + (isComposerInlineTokenNode(node) && point.offset > 0 ? node.getTextContentSize() : point.offset);
}

function $selectDraftOffset(offset: number) {
  let remaining = offset;
  const paragraphs = $getRoot().getChildren();
  for (const [index, paragraph] of paragraphs.entries()) {
    const size = paragraph.getTextContentSize();
    if (remaining > size && index < paragraphs.length - 1) {
      remaining -= size + 1;
      continue;
    }
    if (!$isElementNode(paragraph)) return false;
    const children = paragraph.getChildren();
    for (const [childIndex, child] of children.entries()) {
      if (remaining <= 0) {
        paragraph.select(childIndex, childIndex);
        return true;
      }
      const childSize = child.getTextContentSize();
      if (remaining < childSize && $isTextNode(child) && !isComposerInlineTokenNode(child)) {
        child.select(remaining, remaining);
        return true;
      }
      remaining -= childSize;
    }
    paragraph.select(children.length, children.length);
    return true;
  }
  return false;
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
    const [currentText, caretOffset] = editor.getEditorState().read(() => [serializePromptFromRoot(), $draftOffsetAtSelection()] as const);
    const forceRebuild = !props.value.trim() && currentText.trim() !== "";
    if (!forceRebuild && valueRef.current === props.value) return;
    valueRef.current = props.value;
    if (!forceRebuild && currentText === props.value) return;
    editor.update(() => {
      if (!forceRebuild && serializePromptFromRoot() === props.value) return;
      setPrompt(props.value, props.mentions, props.pastedText, props.attachments);
      const tail = caretOffset === null ? "" : currentText.slice(caretOffset);
      if (!forceRebuild && tail && props.value.endsWith(tail) && $selectDraftOffset(props.value.length - tail.length)) return;
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
        if (event?.isComposing === true || event?.keyCode === 229) return false;
        if (event?.shiftKey) return false;
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
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

function PasteChipPlugin(props: { onPasteText?: (text: string, draftOffset?: number) => void }) {
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
        const files = event.clipboardData?.files;
        if (files && files.length > 0) return false;
        if (event.clipboardData?.getData("text/uri-list").trim()) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text.trim()) return false;
        const wouldOverflowComposer = pastedTextWouldOverflowEditor(text, editor.getRootElement());
        if (shouldCollapsePastedText(text, wouldOverflowComposer)) {
          if (!onPasteTextRef.current) return false;
          event.preventDefault();
          onPasteTextRef.current(text, $draftOffsetAtSelection() ?? undefined);
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

        if ($isTextNode(anchorNode)) {
          const previous = anchorNode.getPreviousSibling();
          if (previous instanceof ComposerSlashCommandNode) {
            const textBefore = anchorNode.getTextContent().slice(0, selection.anchor.offset);
            if (selection.anchor.offset === 0 || textBefore.trim() === "") {
              previous.remove();
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

function LineBoundaryKeysPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        const move = lineBoundaryMoveForKey(event);
        if (!move) return false;
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        event.preventDefault();
        selection.modify(move.alter, move.backward, "lineboundary");
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

function $isLivePoint(point: { key: NodeKey; offset: number; type: "text" | "element" }): boolean {
  const node = $getNodeByKey(point.key);
  if (!node || !node.isAttached()) return false;
  if (point.type === "text") return $isTextNode(node) && point.offset <= node.getTextContentSize();
  return $isElementNode(node) && point.offset <= node.getChildrenSize();
}

function $isCaretAtPromptStart(selection = $getSelection()): boolean {
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.offset !== 0) return false;
  if (!$isLivePoint(selection.anchor)) return false;
  const node = selection.anchor.getNode();
  const first = $getRoot().getFirstDescendant();
  return node.is($getRoot()) || node.is($getRoot().getFirstChild()) || Boolean(first && node.is(first));
}

function KeepCaretOnRefocusPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let saved: { selection: ReturnType<typeof $createRangeSelection>; text: string } | null = null;
    let pointerFocus = false;
    const unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        const text = $getRoot().getTextContent();
        if ($isRangeSelection(selection)) saved = { selection: selection.clone(), text };
        else if (saved && saved.text !== text) saved = null;
      });
    });
    const onPointerDown = () => { pointerFocus = true; };
    const onBlur = () => { pointerFocus = false; };
    const onFocus = () => {
      const fromPointer = pointerFocus;
      pointerFocus = false;
      const restore = saved;
      if (fromPointer || !restore) return;
      requestAnimationFrame(() => {
        if (document.activeElement !== editor.getRootElement()) return;
        editor.update(() => {
          if ($getRoot().getTextContent() !== restore.text) return;
          if (!$isLivePoint(restore.selection.anchor) || !$isLivePoint(restore.selection.focus)) return;
          if (!$isCaretAtPromptStart() || $isCaretAtPromptStart(restore.selection)) return;
          $setSelection(restore.selection.clone());
        });
      });
    };
    const unregisterRoot = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener("pointerdown", onPointerDown, true);
      previous?.removeEventListener("focus", onFocus);
      previous?.removeEventListener("blur", onBlur);
      root?.addEventListener("pointerdown", onPointerDown, true);
      root?.addEventListener("focus", onFocus);
      root?.addEventListener("blur", onBlur);
    });
    return () => {
      unregisterUpdate();
      unregisterRoot();
      const root = editor.getRootElement();
      root?.removeEventListener("pointerdown", onPointerDown, true);
      root?.removeEventListener("focus", onFocus);
      root?.removeEventListener("blur", onBlur);
    };
  }, [editor]);

  return null;
}

function ImperativeHandlePlugin(props: { editorRef: ForwardedRef<LexicalPromptEditorHandle> }) {
  const [editor] = useLexicalComposerContext();

  useImperativeHandle(props.editorRef, () => ({
    replaceSlashAtSelection(trigger, choice) {
      let replaced = false;
      editor.update(() => {
        const match = slashAtSelection();
        if (!match || match.trigger.offset !== trigger.offset || match.trigger.query !== trigger.query) return;
        if (choice.kind === "command" && trigger.offset !== 0) return;
        const chip = choice.kind === "skill"
          ? $createComposerSkillNode(choice.name, choice.token)
          : $createComposerSlashCommandNode(choice.name);
        const end = match.end + (match.node.getTextContent()[match.end] === " " ? 1 : 0);
        const space = $createTextNode(" ");
        match.node.select(match.start, end).insertNodes([chip, space]);
        space.selectEnd();
        replaced = true;
      }, { discrete: true });
      return replaced;
    },
    insertSkillAtSelection(skillName: string, skillToken?: string) {
      editor.update(() => insertSkillAtSelection(skillName, skillToken));
      editor.focus();
    },
    insertMentionAtSelection(kind, value, inline = false) {
      let draft: string | null = null;
      editor.update(() => {
        if (insertMentionAtSelection(kind, value, inline)) draft = serializePromptFromRoot();
      }, { discrete: true });
      return draft;
    },
    insertConnectorAtSelection(connectorName: string) {
      editor.update(() => insertTokenAtSelection($createComposerConnectorNode(connectorName)));
      editor.focus();
    },
    insertSessionReferenceAtSelection(reference, inline = false) {
      let draft: string | null = null;
      editor.update(() => {
        if (insertSessionReferenceAtSelection(reference, inline)) draft = serializePromptFromRoot();
      }, { discrete: true });
      return draft;
    },
    insertFileMentionAtSelection(path: string) {
      let draft = "";
      editor.update(() => {
        insertTokenAtSelection($createComposerMentionNode(path, "file"));
        draft = serializePromptFromRoot();
      }, { discrete: true });
      editor.focus();
      return draft;
    },
    draftOffsetAtSelection() {
      return editor.getEditorState().read(() => $draftOffsetAtSelection());
    },
    draftSelectionRange() {
      return editor.getEditorState().read(() => {
        const start = $draftOffsetAtSelection();
        const end = $draftOffsetAtSelection("end");
        return start === null || end === null ? null : { start, end };
      });
    },
  }), [editor]);

  return null;
}

function attachmentChipButton(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const button = target.closest("button[data-attachment-remove-id], button[data-attachment-expand-id]");
  return button instanceof HTMLButtonElement ? button : null;
}

function AttachmentChipPlugin(props: { onRemoveAttachment?: (id: string) => void; onExpandAttachment?: (id: string) => void }) {
  const [editor] = useLexicalComposerContext();
  const onRemoveAttachmentRef = useRef(props.onRemoveAttachment);
  const onExpandAttachmentRef = useRef(props.onExpandAttachment);

  useEffect(() => {
    onRemoveAttachmentRef.current = props.onRemoveAttachment;
    onExpandAttachmentRef.current = props.onExpandAttachment;
  }, [props.onExpandAttachment, props.onRemoveAttachment]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (!attachmentChipButton(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleClick = (event: MouseEvent) => {
      const button = attachmentChipButton(event.target);
      if (!button) return;
      const removeId = button.dataset.attachmentRemoveId;
      const expandId = button.dataset.attachmentExpandId;
      if (!removeId && !expandId) return;
      event.preventDefault();
      event.stopPropagation();
      if (removeId) onRemoveAttachmentRef.current?.(removeId);
      if (expandId) onExpandAttachmentRef.current?.(expandId);
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

function sessionReferenceChip(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const chip = target.closest("[data-session-reference-session]");
  return chip instanceof HTMLElement ? chip : null;
}

function SessionReferenceChipPlugin(props: { onOpenSessionReference?: (reference: { workspaceId: string; sessionId: string }) => void }) {
  const [editor] = useLexicalComposerContext();
  const onOpenRef = useRef(props.onOpenSessionReference);

  useEffect(() => {
    onOpenRef.current = props.onOpenSessionReference;
  }, [props.onOpenSessionReference]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (!onOpenRef.current || !sessionReferenceChip(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleClick = (event: MouseEvent) => {
      const chip = sessionReferenceChip(event.target);
      const workspaceId = chip?.dataset.sessionReferenceWorkspace;
      const sessionId = chip?.dataset.sessionReferenceSession;
      const open = onOpenRef.current;
      if (!open || !workspaceId || !sessionId) return;
      event.preventDefault();
      event.stopPropagation();
      open({ workspaceId, sessionId });
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
  const onInlineMentionChangeRef = useRef(props.onInlineMentionChange);
  const onMentionQueryChangeRef = useRef(props.onMentionQueryChange);
  const onSlashQueryChangeRef = useRef(props.onSlashQueryChange);
  const onSessionReferenceQueryChangeRef = useRef(props.onSessionReferenceQueryChange);

  useEffect(() => {
    valueRef.current = props.value;
  }, [props.value]);

  useEffect(() => {
    onChangeRef.current = props.onChange;
    onInlineMentionChangeRef.current = props.onInlineMentionChange;
    onMentionQueryChangeRef.current = props.onMentionQueryChange;
    onSlashQueryChangeRef.current = props.onSlashQueryChange;
    onSessionReferenceQueryChangeRef.current = props.onSessionReferenceQueryChange;
  }, [props.onChange, props.onInlineMentionChange, props.onMentionQueryChange, props.onSlashQueryChange, props.onSessionReferenceQueryChange]);

  const initialConfig = useMemo(
    () => ({
      namespace: "openwork-react-session-composer",
      onError(error: Error) {
        throw error;
      },
      editable: true,
      nodes: [ComposerMentionNode, ComposerSlashCommandNode, ComposerSkillNode, ComposerConnectorNode, ComposerSessionReferenceNode, ComposerPastedTextNode, ComposerAttachmentNode],
      editorState: () => {
        setPrompt(props.value, props.mentions, props.pastedText, props.attachments);
      },
    }),
    [],
  );

  const syncPromptFromEditorState = useCallback(
    (state: Parameters<NonNullable<React.ComponentProps<typeof OnChangePlugin>["onChange"]>>[0]) => {
      state.read(() => {
        onInlineMentionChangeRef.current?.(inlineMentionAtSelection()?.trigger ?? null);
        onMentionQueryChangeRef.current?.(mentionAtSelection()?.query ?? null);
        onSlashQueryChangeRef.current?.(slashAtSelection()?.trigger ?? null);
        onSessionReferenceQueryChangeRef.current?.(sessionReferenceTriggerAtSelection());
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
      <div className="group/prompt-editor relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              data-composer-editor=""
              className="min-h-6 max-h-[min(160px,30dvh)] lg:min-h-[60px] lg:max-h-[280px] w-full resize-none overflow-y-auto bg-transparent text-base leading-6 text-dls-text outline-none placeholder:text-dls-secondary lg:text-[13px] lg:leading-[1.55] [&_p]:min-h-[1.5rem] [&_p]:m-0"
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
              {props.placeholderShortcut ? (
                <kbd className="ml-2 hidden rounded border border-dls-border px-1 py-0.5 font-sans text-[11px] leading-none group-has-[[data-composer-editor]:focus]/prompt-editor:inline">
                  {props.placeholderShortcut}
                </kbd>
              ) : null}
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
        <AttachmentChipPlugin onRemoveAttachment={props.onRemoveAttachment} onExpandAttachment={props.onExpandAttachment} />
        <SessionReferenceChipPlugin onOpenSessionReference={props.onOpenSessionReference} />
        <MentionChipNavigationPlugin />
        <LineBoundaryKeysPlugin />
        <KeepCaretOnRefocusPlugin />
        <ImperativeHandlePlugin editorRef={ref} />
      </div>
    </LexicalComposer>
  );
});
