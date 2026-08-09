/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { markdownLivePreview } from "./markdown-live-preview";

const LINE_PREFIX_PATTERN = /^(#{1,6}\s+|>\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/;

function setLinePrefix(view: EditorView, prefix: string | ((index: number) => string)) {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from).number;
  const endLine = state.doc.lineAt(to).number;
  const changes = [];

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const existing = LINE_PREFIX_PATTERN.exec(line.text);
    const insert = typeof prefix === "function" ? prefix(lineNumber - startLine) : prefix;

    changes.push({ from: line.from, to: line.from + (existing ? existing[0].length : 0), insert });
  }

  view.dispatch({ changes });
  view.focus();
}

function wrapSelection(view: EditorView, marker: string) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);

  view.dispatch({
    changes: { from, to, insert: `${marker}${text}${marker}` },
    selection: { anchor: from + marker.length, head: to + marker.length },
  });
  view.focus();
}

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
          // GFM base so tables, strikethrough and task lists parse; the
          // CommonMark default never produces Table nodes to render.
          props.language === "markdown" ? [markdown({ base: markdownLanguage }), markdownLivePreview()] : [],
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

  const editor = <div ref={rootRef} className={cn("h-full min-h-0 overflow-hidden", props.className)} />;

  if (props.language !== "markdown") {
    return editor;
  }

  const format = (apply: (view: EditorView) => void) => {
    const view = viewRef.current;

    if (view) {
      apply(view);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block h-full min-h-0">{editor}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => format((view) => setLinePrefix(view, "# "))}>Heading 1</ContextMenuItem>
        <ContextMenuItem onClick={() => format((view) => setLinePrefix(view, "## "))}>Heading 2</ContextMenuItem>
        <ContextMenuItem onClick={() => format((view) => setLinePrefix(view, "### "))}>Heading 3</ContextMenuItem>
        <ContextMenuItem onClick={() => format((view) => setLinePrefix(view, ""))}>Paragraph</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => format((view) => wrapSelection(view, "**"))}>Bold</ContextMenuItem>
        <ContextMenuItem onClick={() => format((view) => wrapSelection(view, "*"))}>Italic</ContextMenuItem>
        <ContextMenuItem onClick={() => format((view) => wrapSelection(view, "~~"))}>Strikethrough</ContextMenuItem>
        <ContextMenuItem onClick={() => format((view) => wrapSelection(view, "`"))}>Inline code</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => format((view) => setLinePrefix(view, "- "))}>Bullet list</ContextMenuItem>
        <ContextMenuItem onClick={() => format((view) => setLinePrefix(view, (index) => `${index + 1}. `))}>Numbered list</ContextMenuItem>
        <ContextMenuItem onClick={() => format((view) => setLinePrefix(view, "> "))}>Quote</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
