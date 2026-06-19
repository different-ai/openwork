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
  $getRoot,
  $getSelection,
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

type EditorProps = {
  value: string;
  mentions: Record<string, ComposerMentionKind>;
  pastedText?: Array<{ label: string; lines: number }>;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: (options: { queue: boolean }) => void | Promise<void>;
  onExpandPastedText?: (label: string) => void;
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>;
  onPasteText?: (text: string) => void;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDragLeave?: React.DragEventHandler<HTMLDivElement>;
};

export type LexicalPromptEditorHandle = {
  insertSkillAtSelection: (skillName: string) => void;
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
    type: "composer-skill";
    version: 1;
  },
  SerializedTextNode
>;

const MENTION_PILL_CLASS: Record<ComposerMentionKind, string> = {
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

  static override getType() {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode) {
    return new ComposerSkillNode(node.__skillName, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode) {
    return $createComposerSkillNode(serializedNode.skillName);
  }

  constructor(skillName = "", key?: NodeKey) {
    super(`[skill ${skillName}]`, key);
    this.__skillName = skillName;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      type: "composer-skill",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig) {
    const dom = document.createElement("span");
    dom.className = "inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11";
    dom.textContent = this.__skillName;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    dom.title = `Skill: ${this.__skillName}`;
    return dom;
  }

  override updateDOM(prevNode: ComposerSkillNode, dom: HTMLElement) {
    if (prevNode.__skillName !== this.__skillName) {
      dom.textContent = this.__skillName;
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

function $createComposerSkillNode(skillName: string) {
  return $applyNodeReplacement(new ComposerSkillNode(skillName));
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
  button.className = "ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-amber-10 transition-colors hover:bg-amber-4 hover:text-amber-12";
  button.title = "Expand pasted text";
  button.setAttribute("aria-label", "Expand pasted text");
  button.dataset.pastedExpandLabel = label;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("class", "h-3 w-3");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M5 3h8v8h-1.5V5.56l-7.97 7.97-1.06-1.06 7.97-7.97H5V3Z");
  svg.append(path);
  button.append(svg);
  dom.append(text, button);
  return dom;
}

function updatePastedTextChipDom(dom: HTMLElement, label: string, lines: number) {
  const text = dom.firstElementChild;
  if (text) text.textContent = pastedTextChipLabel(lines);
  const button = dom.querySelector("button[data-pasted-expand-label]");
  if (button instanceof HTMLButtonElement) {
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

type ComposerInlineTokenNode = ComposerMentionNode | ComposerSlashCommandNode | ComposerSkillNode | ComposerPastedTextNode;

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

function setPrompt(value: string, mentions: Record<string, ComposerMentionKind>, pastedText?: Array<{ label: string; lines: number }>) {
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

  const segments = value.split(/(\[pasted text [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/);
  const pastedTextByLabel = new Map((pastedText ?? []).map((item) => [item.label, item]));
  for (const segment of segments) {
    if (!segment) continue;
    const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
    if (pasteMatch?.[1]) {
      const target = pastedTextByLabel.get(pasteMatch[1]);
      if (target) {
        paragraph.append($createComposerPastedTextNode(target.label, target.lines));
        continue;
      }
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

function appendSkillAtEnd(skillName: string) {
  const root = $getRoot();
  const lastChild = root.getLastChild();
  const paragraph = $isElementNode(lastChild) ? lastChild : $createParagraphNode();
  if (!$isElementNode(lastChild)) root.append(paragraph);
  const skillNode = $createComposerSkillNode(skillName);
  const spaceNode = $createTextNode(" ");
  paragraph.append(skillNode, spaceNode);
  setSelectionAfterNode(spaceNode);
}

function insertSkillAtSelection(skillName: string) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    appendSkillAtEnd(skillName);
    return;
  }
  const skillNode = $createComposerSkillNode(skillName);
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

function SyncPlugin(props: { value: string; mentions: Record<string, ComposerMentionKind>; pastedText?: Array<{ label: string; lines: number }>; disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  const valueRef = useRef(props.value);

  useEffect(() => {
    editor.setEditable(!props.disabled);
  }, [editor, props.disabled]);

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
      setPrompt(props.value, props.mentions, props.pastedText);
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
  }, [editor, props.mentions, props.pastedText, props.value]);

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
        // Plain Enter submits. Cmd/Ctrl+Enter submits with the queue
        // modifier — while the agent is busy this queues the message to
        // send once the current task finishes.
        event?.preventDefault();
        void onSubmitRef.current({ queue: event?.metaKey === true || event?.ctrlKey === true });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, props.disabled]);

  return null;
}

const PASTE_CHIP_LINE_THRESHOLD = 3;
const PASTE_CHIP_CHAR_THRESHOLD = 200;

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
        if (!onPasteTextRef.current) return false;
        // Only handle plain-text pastes; files are handled in the React onPaste.
        const files = event.clipboardData?.files;
        if (files && files.length > 0) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text.trim()) return false;
        const lineCount = text.split(/\r?\n/).length;
        if (lineCount < PASTE_CHIP_LINE_THRESHOLD && text.length < PASTE_CHIP_CHAR_THRESHOLD) {
          return false;
        }
        // Collapse into a paste chip.
        event.preventDefault();
        onPasteTextRef.current(text);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
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

        // --- Mention / pasted-text chips: atomic delete (same as before) ---
        if ($isTextNode(anchorNode) && selection.anchor.offset === 0) {
          const previous = anchorNode.getPreviousSibling();
          if (previous instanceof ComposerMentionNode || previous instanceof ComposerSkillNode || previous instanceof ComposerPastedTextNode) {
            previous.remove();
            return true;
          }
        }

        if ($isElementNode(anchorNode)) {
          const previous = anchorNode.getChildAtIndex(selection.anchor.offset - 1);
          if (previous instanceof ComposerSlashCommandNode || previous instanceof ComposerMentionNode || previous instanceof ComposerSkillNode || previous instanceof ComposerPastedTextNode) {
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
          if (previous instanceof ComposerMentionNode || previous instanceof ComposerSlashCommandNode || previous instanceof ComposerSkillNode || previous instanceof ComposerPastedTextNode) {
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

        if (anchorNode instanceof ComposerMentionNode || anchorNode instanceof ComposerSlashCommandNode || anchorNode instanceof ComposerSkillNode || anchorNode instanceof ComposerPastedTextNode) {
          setSelectionAfterNode(anchorNode);
          return true;
        }

        if ($isElementNode(anchorNode)) {
          const current = anchorNode.getChildAtIndex(selection.anchor.offset);
          if (current instanceof ComposerMentionNode || current instanceof ComposerSlashCommandNode || current instanceof ComposerSkillNode || current instanceof ComposerPastedTextNode) {
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
    insertSkillAtSelection(skillName: string) {
      editor.update(() => insertSkillAtSelection(skillName));
      editor.focus();
    },
  }), [editor]);

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
        editable: !props.disabled,
        nodes: [ComposerMentionNode, ComposerSlashCommandNode, ComposerSkillNode, ComposerPastedTextNode],
        editorState: () => {
          setPrompt(props.value, props.mentions, props.pastedText);
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

  const handlePastedTextExpandPointer = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("button[data-pasted-expand-label]");
    if (!(button instanceof HTMLButtonElement)) return;
    const label = button.dataset.pastedExpandLabel;
    if (!label) return;
    event.preventDefault();
    event.stopPropagation();
    props.onExpandPastedText?.(label);
  }, [props.onExpandPastedText]);

  const handlePastedTextExpandMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest("button[data-pasted-expand-label]")) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <LexicalComposer initialConfig={initialConfig}>
      {/*
        Tight start, bounded growth:
        - min-h holds the editor to a single-line look until the user starts typing.
        - max-h caps the composer — long pastes / multi-paragraph drafts scroll
          inside the editor instead of pushing the transcript out of view.
      */}
      <div className="relative" onClickCapture={handlePastedTextExpandPointer} onMouseDownCapture={handlePastedTextExpandMouseDown}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="min-h-[60px] max-h-[280px] w-full resize-none overflow-y-auto bg-transparent text-[15px] leading-6 text-dls-text outline-none placeholder:text-dls-secondary [&_p]:min-h-[1.5rem] [&_p]:m-0"
              aria-placeholder={props.placeholder}
              placeholder={<span />}
              onPaste={props.onPaste}
              onDrop={props.onDrop}
              onDragOver={props.onDragOver}
              onDragLeave={props.onDragLeave}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-0 top-0 text-[15px] leading-6 text-dls-secondary/70">
              {props.placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={syncPromptFromEditorState} />
        <HistoryPlugin />
        <SyncPlugin value={props.value} mentions={props.mentions} pastedText={props.pastedText} disabled={props.disabled} />
        <SubmitPlugin onSubmit={props.onSubmit} disabled={props.disabled} />
        <PasteChipPlugin onPasteText={props.onPasteText} />
        <MentionChipNavigationPlugin />
        <ImperativeHandlePlugin editorRef={ref} />
      </div>
    </LexicalComposer>
  );
});
