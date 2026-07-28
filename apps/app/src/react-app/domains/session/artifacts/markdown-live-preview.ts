import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Prec, type Range, RangeSetBuilder, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { renderMarkdownHtml } from "@/components/markdown/markdown-primitive";

/**
 * Obsidian-style "merged" markdown view for CodeMirror 6: the document stays
 * fully editable as plain markdown, but headings, emphasis, lists, quotes and
 * links are rendered inline. Syntax markers (`#`, `*`, `` ` ``, `>`, link
 * brackets) are hidden unless the selection touches the line they belong to,
 * so editing the raw markup is always one click away.
 */

const HIDE = Decoration.replace({});

const HEADING_MARK = [
  Decoration.mark({ class: "cm-md-h1" }),
  Decoration.mark({ class: "cm-md-h2" }),
  Decoration.mark({ class: "cm-md-h3" }),
  Decoration.mark({ class: "cm-md-h4" }),
  Decoration.mark({ class: "cm-md-h5" }),
  Decoration.mark({ class: "cm-md-h6" }),
];

const STRONG = Decoration.mark({ class: "cm-md-strong" });
const EMPHASIS = Decoration.mark({ class: "cm-md-emphasis" });
const STRIKE = Decoration.mark({ class: "cm-md-strike" });
const INLINE_CODE = Decoration.mark({ class: "cm-md-code" });
const LINK_TEXT = Decoration.mark({ class: "cm-md-link" });
const QUOTE = Decoration.line({ class: "cm-md-quote" });
const CODE_BLOCK = Decoration.line({ class: "cm-md-codeblock" });

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "\u2022";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

const BULLET = Decoration.replace({ widget: new BulletWidget() });

function selectionTouches(state: EditorState, from: number, to: number) {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) {
      return true;
    }
  }
  return false;
}

function lineHasSelection(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  return selectionTouches(view.state, line.from, line.to);
}

function buildDecorations(view: EditorView): DecorationSet {
  const widgets: Range<Decoration>[] = [];
  // Force the markdown tree to be parsed across the whole document so headings
  // and inline marks are decorated immediately, even before incremental parsing
  // would otherwise reach them.
  const tree =
    ensureSyntaxTree(view.state, view.state.doc.length, 200) ?? syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        if (name === "Table") {
          // Tables are handled as one block by `tableField`, so their pipes and
          // cell markup are never half-rendered alongside it.
          return false;
        }

        if (/^ATXHeading[1-6]$/.test(name)) {
          const level = Number(name.slice(-1)) - 1;
          widgets.push(HEADING_MARK[level].range(node.from, node.to));
          return;
        }

        if (name === "HeaderMark") {
          // `#` markers and the trailing space; hide unless editing the line.
          if (!lineHasSelection(view, node.from)) {
            const after = view.state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            widgets.push(HIDE.range(node.from, after));
          }
          return;
        }

        if (name === "StrongEmphasis") {
          widgets.push(STRONG.range(node.from, node.to));
          return;
        }
        if (name === "Emphasis") {
          widgets.push(EMPHASIS.range(node.from, node.to));
          return;
        }
        if (name === "Strikethrough") {
          widgets.push(STRIKE.range(node.from, node.to));
          return;
        }
        if (name === "InlineCode") {
          widgets.push(INLINE_CODE.range(node.from, node.to));
          return;
        }

        if (name === "EmphasisMark" || name === "CodeMark" || name === "StrikethroughMark") {
          if (!lineHasSelection(view, node.from)) {
            widgets.push(HIDE.range(node.from, node.to));
          }
          return;
        }

        if (name === "QuoteMark") {
          if (!lineHasSelection(view, node.from)) {
            const after = view.state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            widgets.push(HIDE.range(node.from, after));
          }
          return;
        }

        if (name === "ListMark") {
          const lineText = view.state.doc.lineAt(node.from).text;
          const isBullet = /^\s*[-*+]\s/.test(lineText);
          if (isBullet && !lineHasSelection(view, node.from)) {
            widgets.push(BULLET.range(node.from, node.to));
          }
          return;
        }

        if (name === "LinkMark") {
          if (!lineHasSelection(view, node.from)) {
            widgets.push(HIDE.range(node.from, node.to));
          }
          return;
        }
        if (name === "URL") {
          // Hide the (target) part of a link unless editing it.
          if (!lineHasSelection(view, node.from)) {
            widgets.push(HIDE.range(node.from, node.to));
          }
          return;
        }
      },
    });
  }

  // Line decorations must be applied in document order; collect them separately.
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Blockquote") {
          let pos = node.from;
          while (pos <= node.to) {
            const line = view.state.doc.lineAt(pos);
            widgets.push(QUOTE.range(line.from));
            if (line.to + 1 > node.to) break;
            pos = line.to + 1;
          }
        }
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          let pos = node.from;
          while (pos <= node.to) {
            const line = view.state.doc.lineAt(pos);
            widgets.push(CODE_BLOCK.range(line.from));
            if (line.to + 1 > node.to) break;
            pos = line.to + 1;
          }
        }
      },
    });
  }

  widgets.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);

  const builder = new RangeSetBuilder<Decoration>();
  for (const w of widgets) {
    builder.add(w.from, w.to, w.value);
  }
  return builder.finish();
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      // Rebuild when the document, viewport or selection changes. Also rebuild
      // when the language parser advances (the syntax tree may not be ready in
      // the constructor for large documents), detected via any transaction that
      // touched the language state.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

/**
 * Source lines of a pipe table map to rendered rows: header, delimiter, then one
 * line per body row. Returns how far the clicked row sits from the table start so
 * a click lands the cursor on the row the user aimed at.
 */
function clickedRowOffset(target: EventTarget | null): number {
  const row = target instanceof Element ? target.closest("tr") : null;
  const body = row?.parentElement;
  if (!row || !(body instanceof HTMLTableSectionElement) || body.tagName !== "TBODY") return 0;
  return Array.from(body.rows).indexOf(row) + 2;
}

/**
 * A GFM table rendered as one block. Pipe tables are unreadable as source once
 * they have more than a couple of columns, so the whole table is replaced by the
 * same HTML the rest of the app uses for markdown, and clicking it hands the
 * source back for editing.
 */
class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number) {
    super();
  }

  eq(other: TableWidget) {
    return other.source === this.source && other.from === this.from;
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table";
    // renderMarkdownHtml sanitizes its output.
    wrapper.innerHTML = renderMarkdownHtml(this.source, "surface");
    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const doc = view.state.doc;
      const lineNumber = doc.lineAt(this.from).number + clickedRowOffset(event.target);
      view.dispatch({ selection: { anchor: doc.line(Math.min(lineNumber, doc.lines)).from } });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * Block decorations may not come from a view plugin, so table replacement lives
 * in its own state field.
 */
function buildTableDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      // Selecting into a table returns it to editable markdown.
      if (selectionTouches(state, node.from, node.to)) return false;

      const source = state.doc.sliceString(node.from, node.to);
      builder.add(
        node.from,
        node.to,
        Decoration.replace({ widget: new TableWidget(source, node.from), block: true }),
      );
      return false;
    },
  });

  return builder.finish();
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecorations(state),
  update(value, transaction) {
    if (
      transaction.docChanged ||
      transaction.selection ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
    ) {
      return buildTableDecorations(transaction.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * A rendered table has no text positions inside it, so vertical cursor motion
 * steps straight over it. Arrowing into one puts the cursor on the nearest source
 * line instead, which returns the table to editable markdown.
 */
function enterTable(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view;
  const cursorLine = state.doc.lineAt(state.selection.main.head);
  const probe = direction === 1 ? cursorLine.to + 1 : cursorLine.from - 1;
  if (probe < 0 || probe > state.doc.length) return false;

  let target: number | null = null;
  state.field(tableField).between(probe, probe, (from, to) => {
    target = direction === 1 ? from : state.doc.lineAt(to).from;
    return false;
  });
  if (target === null) return false;

  view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
  return true;
}

const tableKeymap = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: (view) => enterTable(view, 1) },
    { key: "ArrowUp", run: (view) => enterTable(view, -1) },
  ]),
);

const livePreviewTheme = EditorView.baseTheme({
  ".cm-md-h1": { fontSize: "1.6em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-md-h2": { fontSize: "1.4em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-md-h3": { fontSize: "1.2em", fontWeight: "600", lineHeight: "1.3" },
  ".cm-md-h4": { fontSize: "1.1em", fontWeight: "600" },
  ".cm-md-h5": { fontSize: "1.05em", fontWeight: "600" },
  ".cm-md-h6": { fontSize: "1em", fontWeight: "600" },
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-emphasis": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through" },
  ".cm-md-code": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    backgroundColor: "hsl(var(--muted) / 0.6)",
    borderRadius: "4px",
    padding: "0.1em 0.3em",
  },
  ".cm-md-link": { color: "hsl(var(--primary))", textDecoration: "underline" },
  ".cm-md-quote": {
    borderLeft: "3px solid hsl(var(--border))",
    paddingLeft: "0.75em",
    color: "hsl(var(--muted-foreground))",
    fontStyle: "italic",
  },
  ".cm-md-codeblock": {
    backgroundColor: "hsl(var(--muted) / 0.4)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  ".cm-md-bullet": { paddingRight: "0.4em", color: "hsl(var(--muted-foreground))" },
  // `contain: inline-size` keeps a wide table from stretching the editor (which
  // would stop every other paragraph from wrapping); the table scrolls in place.
  ".cm-md-table": { cursor: "text", overflowX: "auto", contain: "inline-size" },
  // Size columns to their content rather than squeezing words apart in a narrow panel.
  ".cm-md-table table": { fontSize: "0.95em", width: "max-content", minWidth: "100%" },
});

export function markdownLivePreview(): Extension {
  return [tableField, tableKeymap, livePreviewPlugin, livePreviewTheme];
}
