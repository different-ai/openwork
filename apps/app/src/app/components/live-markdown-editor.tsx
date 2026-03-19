import { createEffect, onCleanup, onMount } from "solid-js";

import { EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  autofocus?: boolean;
  class?: string;
};

type EmphasisRange = {
  kind: "em" | "strong";
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
  contentFrom: number;
  contentTo: number;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const findEmphasisRanges = (line: string): EmphasisRange[] => {
  // Minimal, line-local emphasis parsing.
  // - Strong: **text**
  // - Emphasis: *text*
  // Avoid matching markers that wrap whitespace.

  const ranges: EmphasisRange[] = [];

  const used = new Array(line.length).fill(false);
  const markUsed = (from: number, to: number) => {
    for (let i = clamp(from, 0, line.length); i < clamp(to, 0, line.length); i += 1) used[i] = true;
  };
  const isUsed = (from: number, to: number) => {
    for (let i = clamp(from, 0, line.length); i < clamp(to, 0, line.length); i += 1) {
      if (used[i]) return true;
    }
    return false;
  };

  // Strong first.
  {
    const re = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const full = m[0] ?? "";
      const inner = m[1] ?? "";
      const from = m.index;
      const to = from + full.length;
      if (!full || !inner) continue;
      if (isUsed(from, to)) continue;

      ranges.push({
        kind: "strong",
        openFrom: from,
        openTo: from + 2,
        contentFrom: from + 2,
        contentTo: to - 2,
        closeFrom: to - 2,
        closeTo: to,
      });
      markUsed(from, to);
    }
  }

  // Emphasis.
  {
    const re = /\*(?!\s)([^*\n]+?)(?<!\s)\*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const full = m[0] ?? "";
      const inner = m[1] ?? "";
      const from = m.index;
      const to = from + full.length;
      if (!full || !inner) continue;
      if (isUsed(from, to)) continue;

      ranges.push({
        kind: "em",
        openFrom: from,
        openTo: from + 1,
        contentFrom: from + 1,
        contentTo: to - 1,
        closeFrom: to - 1,
        closeTo: to,
      });
      markUsed(from, to);
    }
  }

  return ranges;
};

class HiddenMarkerWidget extends WidgetType {
  toDOM() {
    // Zero-width widget that collapses the marker range.
    const el = document.createElement("span");
    el.setAttribute("aria-hidden", "true");
    el.style.display = "inline-block";
    el.style.width = "0";
    el.style.overflow = "hidden";
    return el;
  }
}

const obsidianishLivePreview = () => {
  const headingLine = (level: number) =>
    Decoration.line({ attributes: { class: `cm-ow-heading cm-ow-heading-${level}` } });
  const hide = Decoration.replace({ widget: new HiddenMarkerWidget() });
  const emMark = Decoration.mark({ class: "cm-ow-em" });
  const strongMark = Decoration.mark({ class: "cm-ow-strong" });

  const compute = (state: EditorState): DecorationSet => {
    const ranges: any[] = [];
    const add = (from: number, to: number, deco: any) => {
      ranges.push(deco.range(from, to));
    };

    const doc = state.doc;
    const selections = state.selection.ranges;
    const activeLines = new Set<number>();
    for (const r of selections) {
      const fromLine = doc.lineAt(r.from).number;
      const toLine = doc.lineAt(r.to).number;
      for (let n = fromLine; n <= toLine; n += 1) activeLines.add(n);
      if (r.empty) activeLines.add(doc.lineAt(r.head).number);
    }

    const cursorPos = state.selection.main.head;
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
      const line = doc.line(lineNumber);
      const lineText = line.text;
      const lineActive = activeLines.has(line.number);

      // Headings: hide leading '#' when line is not active.
      const headingMatch = /^(#{1,6})\s+/.exec(lineText);
      if (headingMatch) {
        const level = headingMatch[1]?.length ?? 1;
        add(line.from, line.from, headingLine(level));

        if (!lineActive) {
          const markerLen = (headingMatch[0] ?? "").length;
          add(line.from, line.from + markerLen, hide);
        }
      }

      // Emphasis / strong emphasis: style inner text; hide markers unless cursor is inside.
      for (const r of findEmphasisRanges(lineText)) {
        const absOpenFrom = line.from + r.openFrom;
        const absOpenTo = line.from + r.openTo;
        const absCloseFrom = line.from + r.closeFrom;
        const absCloseTo = line.from + r.closeTo;
        const absContentFrom = line.from + r.contentFrom;
        const absContentTo = line.from + r.contentTo;
        if (absContentTo <= absContentFrom) continue;

        const cursorInside = cursorPos >= absOpenFrom && cursorPos <= absCloseTo;
        const mark = r.kind === "strong" ? strongMark : emMark;

        if (!cursorInside) {
          add(absOpenFrom, absOpenTo, hide);
        }

        add(absContentFrom, absContentTo, mark);

        if (!cursorInside) {
          add(absCloseFrom, absCloseTo, hide);
        }
      }

    }

    return Decoration.set(ranges, true);
  };

  const field = StateField.define<DecorationSet>({
    create(state) {
      return compute(state);
    },
    update(value, tr) {
      if (tr.docChanged || tr.selection) return compute(tr.state);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return field;
};

const editorTheme = EditorView.theme({
    "&": {
      fontSize: "14px",
    },
    ".cm-scroller": {
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial",
    },
    ".cm-content": {
      padding: "12px 14px",
      caretColor: "var(--dls-text-primary)",
    },
    ".cm-line": {
      padding: "0 2px",
    },
    ".cm-focused": {
      outline: "none",
    },
    ".cm-selectionBackground": {
      backgroundColor: "rgba(var(--dls-accent-rgb) / 0.18)",
    },
    ".cm-focused .cm-selectionBackground": {
      backgroundColor: "rgba(var(--dls-accent-rgb) / 0.22)",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--dls-text-primary)",
    },
    ".cm-placeholder": {
      color: "var(--dls-text-secondary)",
    },
    ".cm-ow-em": {
      fontStyle: "italic",
    },
    ".cm-ow-strong": {
      fontWeight: "650",
    },
    ".cm-ow-heading": {
      letterSpacing: "-0.01em",
    },
    ".cm-line.cm-ow-heading-1": {
      fontSize: "28px",
      fontWeight: "750",
      lineHeight: "1.15",
      paddingTop: "6px",
      paddingBottom: "6px",
    },
    ".cm-line.cm-ow-heading-2": {
      fontSize: "22px",
      fontWeight: "720",
      lineHeight: "1.2",
      paddingTop: "6px",
      paddingBottom: "6px",
    },
    ".cm-line.cm-ow-heading-3": {
      fontSize: "18px",
      fontWeight: "700",
      lineHeight: "1.25",
      paddingTop: "5px",
      paddingBottom: "5px",
    },
    ".cm-line.cm-ow-heading-4": {
      fontSize: "16px",
      fontWeight: "680",
      lineHeight: "1.3",
      paddingTop: "4px",
      paddingBottom: "4px",
    },
    ".cm-line.cm-ow-heading-5": {
      fontSize: "15px",
      fontWeight: "660",
      lineHeight: "1.35",
      paddingTop: "3px",
      paddingBottom: "3px",
    },
    ".cm-line.cm-ow-heading-6": {
      fontSize: "14px",
      fontWeight: "650",
      lineHeight: "1.4",
      paddingTop: "2px",
      paddingBottom: "2px",
    },
});

export default function LiveMarkdownEditor(props: Props) {
  let hostEl: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  const createState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.lineWrapping,
        cmPlaceholder(props.placeholder ?? ""),
        editorTheme,
        obsidianishLivePreview(),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          props.onChange(update.state.doc.toString());
        }),
      ],
    });

  onMount(() => {
    if (!hostEl) return;
    view = new EditorView({
      state: createState(props.value ?? ""),
      parent: hostEl,
    });

    if (props.autofocus) {
      queueMicrotask(() => view?.focus());
    }
  });

  createEffect(() => {
    if (!view) return;
    const next = props.value ?? "";
    const current = view.state.doc.toString();
    if (next === current) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
  });

  onCleanup(() => {
    view?.destroy();
    view = undefined;
  });

  return (
    <div
      class={props.class}
      aria-label={props.ariaLabel}
      role="textbox"
      ref={(el) => (hostEl = el)}
    />
  );
}
