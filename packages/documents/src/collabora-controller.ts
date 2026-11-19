import { useCallback, useEffect, useState, type RefObject } from "react"
import { z } from "zod"
import type { EditorAction, EditorCommand, EditorController, EditorSelection } from "./editor-controller"
import { officeFormats, type OfficeSession } from "./office-engine"

const actions = {
  undo: "Undo", redo: "Redo", bold: "Bold", italic: "Italic", underline: "Underline", strikethrough: "Strikeout",
  "align-left": "LeftPara", "align-center": "CenterPara", "align-right": "RightPara", "align-justify": "JustifyPara",
  "bullet-list": "DefaultBullet", "numbered-list": "DefaultNumbering", indent: "IncrementIndent", outdent: "DecrementIndent", "clear-formatting": "ResetAttributes",
  "insert-link": "HyperlinkDialog", "insert-comment": "InsertAnnotation", "insert-image": "InsertGraphic", "page-break": "InsertPagebreak",
  find: "SearchDialog", "format-paragraph": "ParagraphDialog", "page-layout": "PageDialog", "format-cells": "FormatCellDialog",
  "insert-row": "InsertRowsBefore", "insert-column": "InsertColumnsBefore", "delete-row": "DeleteRows", "delete-column": "DeleteColumns",
  "merge-cells": "ToggleMergeCells", "sort-ascending": "SortAscending", "sort-descending": "SortDescending", filter: "DataFilterAutoFilter",
  currency: "NumberFormatCurrency", percent: "NumberFormatPercent", number: "NumberFormatDecimal",
  "new-slide": "InsertPage", "duplicate-slide": "DuplicatePage", "delete-slide": "DeletePage",
  "slide-notes": "NotesMode", "slide-view": "NormalMultiPaneGUI", "text-box": "Text", present: "Presentation",
} satisfies Record<EditorAction, string>
type UnoValue = { type: "string" | "float" | "long" | "short"; value: string | number }
type UnoCommand = { Command: string; Args?: Record<string, UnoValue> }

/** A closed command translation, with bounds even when another host supplies its own controls. */
export function collaboraCommand(command: EditorCommand, kind: EditorController["kind"]): UnoCommand {
  switch (command.type) {
    case "action": {
      if (!Object.hasOwn(actions, command.action)) throw new Error("Choose a supported editing action.")
      return { Command: `.uno:${actions[command.action]}` }
    }
    case "font": {
      if (!command.value.trim() || command.value.length > 100) throw new Error("Choose a font name of 100 characters or less.")
      return { Command: ".uno:CharFontName", Args: { "CharFontName.FamilyName": { type: "string", value: command.value } } }
    }
    case "font-size": {
      if (!Number.isFinite(command.value) || command.value < 1 || command.value > 96) throw new Error("Choose a font size between 1 and 96.")
      return { Command: ".uno:FontHeight", Args: { "FontHeight.Height": { type: "float", value: command.value } } }
    }
    case "style": {
      if (!["Default Paragraph Style", "Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3"].includes(command.value)) throw new Error("Choose a supported paragraph style.")
      return { Command: ".uno:StyleApply", Args: { Style: { type: "string", value: command.value }, FamilyName: { type: "string", value: "ParagraphStyles" } } }
    }
    case "color": case "highlight": {
      if (!/^#[0-9a-f]{6}$/i.test(command.value)) throw new Error("Choose a valid color.")
      const name = command.type === "highlight" ? kind === "spreadsheet" ? "BackgroundColor" : "CharBackColor" : kind === "spreadsheet" ? "Color" : "FontColor"
      return { Command: `.uno:${name}`, Args: { [name]: { type: "long", value: Number.parseInt(command.value.slice(1), 16) } } }
    }
    case "table": {
      if (![command.rows, command.columns].every(value => Number.isInteger(value) && value >= 1 && value <= 20)) throw new Error("Choose up to 20 rows and columns.")
      return { Command: ".uno:InsertTable", Args: { Rows: { type: "short", value: command.rows }, Columns: { type: "short", value: command.columns } } }
    }
    case "zoom": {
      if (!Number.isInteger(command.value) || command.value < 50 || command.value > 200) throw new Error("Choose a zoom between 50% and 200%.")
      return { Command: ".uno:Zoom", Args: { "Zoom.Value": { type: "short", value: command.value }, "Zoom.ValueSet": { type: "short", value: 28703 }, "Zoom.Type": { type: "short", value: 0 } } }
    }
    case "slide-layout": {
      const layouts = { blank: 20, title: 0, content: 1, "two-columns": 3, "title-only": 19 }
      if (kind !== "presentation" || !Object.hasOwn(layouts, command.value)) throw new Error("Choose a supported slide layout.")
      return { Command: ".uno:AssignLayout", Args: { WhatLayout: { type: "long", value: layouts[command.value] } } }
    }
  }
}

const selectionSchema = z.object({
  bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(),
  font: z.string().max(100).optional(), fontSize: z.number().finite().optional(), style: z.string().max(100).optional(),
  alignment: z.enum(["left", "center", "right", "justify"]).optional(), canUndo: z.boolean().optional(), canRedo: z.boolean().optional(),
})
const bridgeMessage = z.discriminatedUnion("MessageId", [
  z.object({ MessageId: z.literal("OpenWork_Ready"), Values: z.object({ version: z.literal(1) }) }),
  z.object({ MessageId: z.literal("OpenWork_Selection"), Values: selectionSchema }),
  z.object({ MessageId: z.literal("OpenWork_Tools"), Values: z.object({ open: z.boolean() }) }),
])

export function collaboraWorkspaceUrl(value: string) {
  const url = new URL(value)
  url.searchParams.set("integrator", "openwork")
  url.searchParams.set("ui_defaults", "UIMode=classic;TextRuler=false;TextSidebar=false;SpreadsheetSidebar=false;")
  return url.toString()
}

/** Only colors cross into the editor theme, never CSS rules or document content. */
function hostColors(element: HTMLElement) {
  const style = getComputedStyle(element)
  const colors: Record<string, string> = {}
  for (const [name, token] of Object.entries({ bg: "--doc-bg", text: "--doc-text", muted: "--doc-muted", chip: "--doc-chip", line: "--doc-line", surface: "--wb-surface" })) {
    const value = style.getPropertyValue(token).trim()
    if (value.length <= 100 && CSS.supports("color", value)) colors[name] = value
  }
  return colors
}

export function useCollaboraController({ frame, session, ready, canEdit, active }: {
  frame: RefObject<HTMLIFrameElement | null>; session?: OfficeSession; ready: boolean; canEdit: boolean; active: boolean
}): EditorController {
  const [connected, setConnected] = useState(false)
  const [selection, setSelection] = useState<EditorSelection>({})
  const [advanced, setAdvanced] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const kind = session ? officeFormats[session.fileType].kind : "document"
  const send = useCallback((MessageId: string, Values: object = {}) => {
    if (session) frame.current?.contentWindow?.postMessage(JSON.stringify({ MessageId, SendTime: Date.now(), Values }), new URL(session.serverUrl).origin)
  }, [frame, session])
  useEffect(() => {
    if (!session) return
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== new URL(session.serverUrl).origin) return
      let value = event.data
      if (typeof value === "string") { if (value.length > 4000) return; try { value = JSON.parse(value) } catch { return } }
      const result = bridgeMessage.safeParse(value)
      if (!result.success) return
      const message = result.data
      if (message.MessageId === "OpenWork_Ready") {
        setConnected(true)
        setUnavailable(false)
        const host = frame.current?.closest<HTMLElement>(".ow-documents")
        if (host) send("OpenWork_Theme", hostColors(host))
      } else if (message.MessageId === "OpenWork_Selection") setSelection(message.Values)
      else setAdvanced(message.Values.open)
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [frame, session, send])
  useEffect(() => {
    if (!ready || !active || connected) return
    send("OpenWork_Connect")
    const timer = setTimeout(() => setUnavailable(true), 6500)
    return () => clearTimeout(timer)
  }, [ready, active, connected, send])
  return {
    kind, ready: ready && connected, canEdit, selection, advanced,
    notice: unavailable && !connected ? "OpenWork editing controls aren't available. An admin can update the document service. You can keep editing with the existing controls below." : undefined,
    execute(command) {
      if (!ready || !connected || command.type !== "zoom" && (command.type !== "action" || !["find", "present"].includes(command.action)) && !canEdit) return
      if (command.type === "action" && command.action === "present") send("Action_FullscreenPresentation", { CurrentSlide: true })
      else send("Send_UNO_Command", collaboraCommand(command, kind))
      send("Grab_Focus")
      frame.current?.focus()
    },
    setAdvanced(open) { if (ready && connected) send("OpenWork_Tools", { open }) },
  }
}
