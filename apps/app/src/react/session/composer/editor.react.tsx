/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef } from "react";
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
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  type SerializedTextNode,
  type Spread,
  TextNode,
  type EditorConfig,
  type NodeKey,
} from "lexical";
import type { InitialConfigType } from "@lexical/react/LexicalComposer.js";

type EditorProps = {
  value: string;
  mentions: Record<string, "agent" | "file">;
  pastedText?: Array<{ label: string; lines: number }>;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDragLeave?: React.DragEventHandler<HTMLDivElement>;
};

type SerializedComposerMentionNode = Spread<
  {
    mentionValue: string;
    mentionKind: "agent" | "file";
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

class ComposerMentionNode extends TextNode {
  __value: string;
  __kind: "agent" | "file";

  static override getType() {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode) {
    return new ComposerMentionNode(node.__value, node.__kind, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode) {
    return $createComposerMentionNode(serializedNode.mentionValue, serializedNode.mentionKind);
  }

  constructor(value = "", kind: "agent" | "file" = "file", key?: NodeKey) {
    super(`@${value}`, key);
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
    const isFile = this.__kind === "file";
    dom.className = this.__kind === "file"
      ? "inline-flex items-center rounded-full border border-gray-6 bg-gray-3 px-2.5 py-1 text-xs font-medium text-gray-11"
      : "inline-flex items-center rounded-full border border-sky-6/35 bg-sky-3/20 px-2.5 py-1 text-xs font-medium text-sky-11";
    dom.textContent = `${isFile ? "📄 " : "🤖 "}@${isFile ? this.__value.split(/[\\/]/).pop() || this.__value : this.__value}`;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    dom.title = `@${this.__value}`;
    return dom;
  }

  override updateDOM(prevNode: ComposerMentionNode, dom: HTMLElement) {
    if (prevNode.__value !== this.__value || prevNode.__kind !== this.__kind) {
      const isFile = this.__kind === "file";
      dom.className = this.__kind === "file"
        ? "inline-flex items-center rounded-full border border-gray-6 bg-gray-3 px-2.5 py-1 text-xs font-medium text-gray-11"
        : "inline-flex items-center rounded-full border border-sky-6/35 bg-sky-3/20 px-2.5 py-1 text-xs font-medium text-sky-11";
      dom.textContent = `${isFile ? "📄 " : "🤖 "}@${isFile ? this.__value.split(/[\\/]/).pop() || this.__value : this.__value}`;
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

function $createComposerMentionNode(value: string, kind: "agent" | "file") {
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
    const dom = document.createElement("span");
    dom.className = "inline-flex items-center gap-1 rounded-full border border-amber-6/35 bg-amber-3/15 px-2.5 py-1 text-xs font-medium text-amber-11";
    dom.textContent = `📋 ${this.__pastedLines} lines`;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    dom.title = `Pasted text · ${this.__pastedLabel}`;
    return dom;
  }

  override updateDOM(prevNode: ComposerPastedTextNode, dom: HTMLElement) {
    if (prevNode.__pastedLabel !== this.__pastedLabel || prevNode.__pastedLines !== this.__pastedLines) {
      dom.textContent = `📋 ${this.__pastedLines} lines`;
      dom.title = `Pasted text · ${this.__pastedLabel}`;
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

type ComposerInlineTokenNode = ComposerMentionNode | ComposerSlashCommandNode | ComposerPastedTextNode;

function setSelectionAfterNode(node: ComposerInlineTokenNode) {
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

function setPrompt(value: string, mentions: Record<string, "agent" | "file">, pastedText?: Array<{ label: string; lines: number }>) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);
  const slashMatch = value.match(/^\/(\S+)\s(.*)$/s);
  if (slashMatch?.[1]) {
    paragraph.append($createComposerSlashCommandNode(slashMatch[1]));
    paragraph.append($createTextNode(" "));
    value = slashMatch[2] ?? "";
  }
  const segments = value.split(/(\[pasted text [^\]]+\]|@[^\s@]+)/);
  for (const segment of segments) {
    if (!segment) continue;
    const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
    if (pasteMatch?.[1]) {
      const target = pastedText?.find((item) => item.label === pasteMatch[1]);
      if (target) {
        paragraph.append($createComposerPastedTextNode(target.label, target.lines));
        continue;
      }
    }
    if (segment.startsWith("@")) {
      const token = segment.slice(1);
      const kind = mentions[token];
      if (kind) {
        paragraph.append($createComposerMentionNode(token, kind));
        continue;
      }
    }
    paragraph.append($createTextNode(segment));
  }
}

function SyncPlugin(props: { value: string; mentions: Record<string, "agent" | "file">; pastedText?: Array<{ label: string; lines: number }>; disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  const valueRef = useRef(props.value);

  useEffect(() => {
    editor.setEditable(!props.disabled);
  }, [editor, props.disabled]);

  useEffect(() => {
    if (valueRef.current === props.value) return;
    valueRef.current = props.value;
    editor.update(() => {
      const root = $getRoot();
      if (root.getTextContent() === props.value) return;
      setPrompt(props.value, props.mentions, props.pastedText);
      root.selectEnd();
    });
  }, [editor, props.mentions, props.value]);

  return null;
}

function SubmitPlugin(props: { onSubmit: () => void | Promise<void>; disabled: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (props.disabled) return false;
        if (!event?.metaKey && !event?.ctrlKey) return false;
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        event.preventDefault();
        void props.onSubmit();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, props.disabled, props.onSubmit]);

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

        if ($isTextNode(anchorNode) && selection.anchor.offset === 0) {
          const previous = anchorNode.getPreviousSibling();
          if (previous instanceof ComposerMentionNode || previous instanceof ComposerSlashCommandNode || previous instanceof ComposerPastedTextNode) {
            previous.remove();
            return true;
          }
        }

        if ($isElementNode(anchorNode)) {
          const previous = anchorNode.getChildAtIndex(selection.anchor.offset - 1);
          if (previous instanceof ComposerMentionNode || previous instanceof ComposerPastedTextNode) {
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
          if (previous instanceof ComposerMentionNode || previous instanceof ComposerSlashCommandNode || previous instanceof ComposerPastedTextNode) {
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

        if (anchorNode instanceof ComposerMentionNode || anchorNode instanceof ComposerSlashCommandNode || anchorNode instanceof ComposerPastedTextNode) {
          setSelectionAfterNode(anchorNode);
          return true;
        }

        if ($isElementNode(anchorNode)) {
          const current = anchorNode.getChildAtIndex(selection.anchor.offset);
          if (current instanceof ComposerMentionNode || current instanceof ComposerSlashCommandNode || current instanceof ComposerPastedTextNode) {
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

export function LexicalPromptEditor(props: EditorProps) {
  const initialConfig = useMemo(
    () => ({
      namespace: "openwork-react-session-composer",
      onError(error: Error) {
        throw error;
      },
        editable: !props.disabled,
        nodes: [ComposerMentionNode, ComposerSlashCommandNode, ComposerPastedTextNode],
        editorState: () => {
          setPrompt(props.value, props.mentions, props.pastedText);
        },
      }),
    [],
  );

  const handleChange = useCallback(
    (state: Parameters<NonNullable<React.ComponentProps<typeof OnChangePlugin>["onChange"]>>[0]) => {
      state.read(() => {
        props.onChange($getRoot().getTextContent());
      });
    },
    [props],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative min-h-[180px] px-6 py-5">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="min-h-[140px] w-full resize-none bg-transparent text-base text-dls-text outline-none placeholder:text-dls-secondary"
              aria-placeholder={props.placeholder}
              placeholder={<span />}
              onPaste={props.onPaste}
              onDrop={props.onDrop}
              onDragOver={props.onDragOver}
              onDragLeave={props.onDragLeave}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute left-6 top-5 text-base text-dls-secondary/70">
              {props.placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleChange} />
        <HistoryPlugin />
        <SyncPlugin value={props.value} mentions={props.mentions} pastedText={props.pastedText} disabled={props.disabled} />
        <SubmitPlugin onSubmit={props.onSubmit} disabled={props.disabled} />
        <MentionChipNavigationPlugin />
      </div>
    </LexicalComposer>
  );
}
