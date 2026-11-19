/** The workspace owns these commands; rendering engines translate them at their boundary. */
export type EditorAction =
  | "undo" | "redo" | "bold" | "italic" | "underline" | "strikethrough"
  | "align-left" | "align-center" | "align-right" | "align-justify"
  | "bullet-list" | "numbered-list" | "indent" | "outdent" | "clear-formatting"
  | "insert-link" | "insert-comment" | "insert-image" | "page-break"
  | "find" | "format-paragraph" | "page-layout" | "format-cells"
  | "insert-row" | "insert-column" | "delete-row" | "delete-column" | "merge-cells"
  | "sort-ascending" | "sort-descending" | "filter" | "currency" | "percent" | "number"
  | "new-slide" | "duplicate-slide" | "delete-slide" | "slide-notes" | "slide-view" | "text-box" | "present"

export type EditorCommand =
  | { type: "action"; action: EditorAction }
  | { type: "font"; value: string }
  | { type: "font-size"; value: number }
  | { type: "style"; value: string }
  | { type: "color" | "highlight"; value: string }
  | { type: "table"; rows: number; columns: number }
  | { type: "slide-layout"; value: "blank" | "title" | "content" | "two-columns" | "title-only" }
  | { type: "zoom"; value: number }

export type EditorSelection = {
  bold?: boolean; italic?: boolean; underline?: boolean
  font?: string; fontSize?: number; style?: string
  alignment?: "left" | "center" | "right" | "justify"
  canUndo?: boolean; canRedo?: boolean
}

/** Composable React controls depend on this contract, never an engine's global or DOM. */
export type EditorController = {
  kind: "document" | "spreadsheet" | "presentation"
  ready: boolean
  canEdit: boolean
  selection: EditorSelection
  advanced: boolean
  notice?: string
  execute(command: EditorCommand): void
  setAdvanced(open: boolean): void
}
