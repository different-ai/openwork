/**
 * [INPUT]: 依赖 CodeMirror、Markdown 语言包与本模块的实时预览装饰
 * [OUTPUT]: 对外提供 ArtifactTextEditor，编辑纯文本或可视化 Markdown 并回传内容变化
 * [POS]: session/artifacts 的文本编辑 Adapter，由 ArtifactPanel 负责持久化
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { cn } from "@/lib/utils";
import { markdownLivePreview } from "./markdown-live-preview";

type ArtifactTextEditorProps = {
  className?: string;
  value: string;
  language: "markdown" | "text";
  onChange: (value: string) => void;
};

export function ArtifactTextEditor(props: ArtifactTextEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(props.onChange);

  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    const view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          props.language === "markdown" ? [] : lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          props.language === "markdown" ? [markdown(), markdownLivePreview()] : [],
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          props.language === "markdown"
            ? EditorView.theme({
                "&": { height: "100%", background: "transparent" },
                ".cm-scroller": { fontFamily: "inherit" },
                ".cm-content": { minHeight: "100%", padding: "16px", maxWidth: "768px", margin: "0 auto", fontSize: "14px", lineHeight: "1.7" },
                ".cm-activeLine": { backgroundColor: "transparent" },
              })
            : EditorView.theme({
                "&": { height: "100%", background: "transparent" },
                ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" },
                ".cm-content": { minHeight: "100%", padding: "12px 0", fontSize: "12px", lineHeight: "20px" },
                ".cm-gutters": { background: "transparent", borderRight: "1px solid hsl(var(--border))" },
                ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px", color: "hsl(var(--muted-foreground))" },
                ".cm-activeLine": { backgroundColor: "hsl(var(--muted) / 0.35)" },
                ".cm-activeLineGutter": { backgroundColor: "hsl(var(--muted) / 0.35)" },
              }),
        ],
      }),
    });

    viewRef.current = view;

    // Dev-only handle so e2e flows can drive the editor selection.
    if (import.meta.env.DEV) {
      (window as unknown as { __artifactEditorView?: EditorView }).__artifactEditorView = view;
    }

    return () => {
      view.destroy();
      viewRef.current = null;
      if (import.meta.env.DEV) {
        delete (window as unknown as { __artifactEditorView?: EditorView }).__artifactEditorView;
      }
    };
  }, [props.language]);

  useEffect(() => {
    const view = viewRef.current;

    if (!view) {
      return;
    }

    const current = view.state.doc.toString();

    if (current === props.value) {
      return;
    }

    view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  return <div ref={rootRef} className={cn("h-full min-h-0 overflow-hidden", props.className)} />;
}
