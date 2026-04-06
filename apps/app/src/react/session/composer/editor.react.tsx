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
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
} from "lexical";
import type { InitialConfigType } from "@lexical/react/LexicalComposer.js";

type EditorProps = {
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
};

function SyncPlugin(props: { value: string; disabled: boolean }) {
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
      root.clear();
      const paragraph = $createParagraphNode();
      if (props.value) {
        paragraph.append($createTextNode(props.value));
      }
      root.append(paragraph);
      root.selectEnd();
    });
  }, [editor, props.value]);

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
      editorState: () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        if (props.value) {
          paragraph.append($createTextNode(props.value));
        }
        root.append(paragraph);
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
        <SyncPlugin value={props.value} disabled={props.disabled} />
        <SubmitPlugin onSubmit={props.onSubmit} disabled={props.disabled} />
      </div>
    </LexicalComposer>
  );
}
