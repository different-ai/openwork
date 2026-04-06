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
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  TextNode,
  type EditorConfig,
  type NodeKey,
} from "lexical";
import type { InitialConfigType } from "@lexical/react/LexicalComposer.js";

type EditorProps = {
  value: string;
  mentions: Record<string, "agent" | "file">;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
};

class ComposerMentionNode extends TextNode {
  __value: string;
  __kind: "agent" | "file";

  static override getType() {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode) {
    return new ComposerMentionNode(node.__value, node.__kind, node.__key);
  }

  constructor(value: string, kind: "agent" | "file", key?: NodeKey) {
    super(`@${value}`, key);
    this.__value = value;
    this.__kind = kind;
  }

  override createDOM(_config: EditorConfig) {
    const dom = document.createElement("span");
    dom.className = this.__kind === "file"
      ? "inline-flex items-center rounded-full border border-gray-6 bg-gray-3 px-2.5 py-1 text-xs font-medium text-gray-11"
      : "inline-flex items-center rounded-full border border-sky-6/35 bg-sky-3/20 px-2.5 py-1 text-xs font-medium text-sky-11";
    dom.textContent = `@${this.__value}`;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    return dom;
  }

  override updateDOM(prevNode: ComposerMentionNode, dom: HTMLElement) {
    if (prevNode.__value !== this.__value || prevNode.__kind !== this.__kind) {
      dom.className = this.__kind === "file"
        ? "inline-flex items-center rounded-full border border-gray-6 bg-gray-3 px-2.5 py-1 text-xs font-medium text-gray-11"
        : "inline-flex items-center rounded-full border border-sky-6/35 bg-sky-3/20 px-2.5 py-1 text-xs font-medium text-sky-11";
      dom.textContent = `@${this.__value}`;
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

function setPrompt(value: string, mentions: Record<string, "agent" | "file">) {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);
  const segments = value.split(/(@[^\s@]+)/);
  for (const segment of segments) {
    if (!segment) continue;
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

function SyncPlugin(props: { value: string; mentions: Record<string, "agent" | "file">; disabled: boolean }) {
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
      setPrompt(props.value, props.mentions);
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

export function LexicalPromptEditor(props: EditorProps) {
  const initialConfig = useMemo(
    () => ({
      namespace: "openwork-react-session-composer",
      onError(error: Error) {
        throw error;
      },
        editable: !props.disabled,
        nodes: [ComposerMentionNode],
        editorState: () => {
          setPrompt(props.value, props.mentions);
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
        <SyncPlugin value={props.value} mentions={props.mentions} disabled={props.disabled} />
        <SubmitPlugin onSubmit={props.onSubmit} disabled={props.disabled} />
      </div>
    </LexicalComposer>
  );
}
