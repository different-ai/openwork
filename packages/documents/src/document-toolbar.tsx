import { Menu } from "@base-ui/react/menu"
import { Popover } from "@base-ui/react/popover"
import { Toolbar } from "@base-ui/react/toolbar"
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Check, ChevronDown, Highlighter, Italic, List, ListOrdered, MoreHorizontal, Palette, Play, Redo2, Search, SlidersHorizontal, Undo2, Underline } from "lucide-react"
import { useRef, useState, type ReactNode } from "react"
import type { EditorAction, EditorCommand, EditorController } from "./editor-controller"

type MenuOption = { label: string; command: EditorCommand; checked?: boolean; icon?: ReactNode }
type PopupTheme = Partial<Record<`--doc-${string}`, string>>
function useToolbarTheme() {
  const trigger = useRef<HTMLButtonElement>(null)
  const [theme, setTheme] = useState<PopupTheme>({})
  const inherit = () => {
    if (!trigger.current) return
    const style = getComputedStyle(trigger.current)
    const next: PopupTheme = {}
    const tokens: readonly `--doc-${string}`[] = ["--doc-bg", "--doc-surface", "--doc-text", "--doc-muted", "--doc-chip", "--doc-line", "--doc-panel-shadow"]
    for (const token of tokens) next[token] = style.getPropertyValue(token).trim()
    setTheme(next)
  }
  return { trigger, theme, inherit }
}

/** A reusable menu; Base UI owns keyboard navigation, dismissal, and collision handling. */
export function EditorToolbarMenu({ label, children, options, controller, className = "" }: {
  label: string; children: ReactNode; options: readonly MenuOption[]; controller: EditorController; className?: string
}) {
  const executed = useRef(false)
  const [open, setOpen] = useState(false)
  const allowed = controller.ready && controller.canEdit
  const { trigger, theme, inherit } = useToolbarTheme()
  return <Menu.Root modal={false} open={open && allowed} onOpenChange={next => { if (!allowed) return; setOpen(next); if (next) { executed.current = false; inherit() } }}>
    <Toolbar.Button ref={trigger} render={<Menu.Trigger/>} className={`ow-editor-control ${className}`} disabled={!controller.ready || !controller.canEdit} aria-label={label}>{children}<ChevronDown size={12} aria-hidden/></Toolbar.Button>
    <Menu.Portal keepMounted={open && !allowed} hidden={!allowed} inert={!allowed} style={!allowed ? { display: "none" } : undefined}><Menu.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="ow-editor-positioner">
      <Menu.Popup className="ow-editor-menu" style={theme} aria-label={label} finalFocus={() => executed.current ? false : true}>
        {options.map(option => <Menu.Item key={option.label} className="ow-editor-menu-item" onClick={() => { executed.current = true; controller.execute(option.command) }}>
          {option.icon}<span>{option.label}</span>{option.checked && <Check size={14} aria-hidden/>}
        </Menu.Item>)}
      </Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>
}

export function EditorToolbarButton({ label, children, action, controller, pressed, disabled }: {
  label: string; children: ReactNode; action: EditorAction; controller: EditorController; pressed?: boolean; disabled?: boolean
}) {
  return <Toolbar.Button type="button" className="ow-editor-control ow-editor-icon-control" title={label} aria-label={label} aria-pressed={pressed} disabled={!controller.ready || !["find", "present"].includes(action) && !controller.canEdit || disabled} onMouseDown={event => event.preventDefault()} onClick={() => controller.execute({ type: "action", action })}>{children}</Toolbar.Button>
}

function ColorControls({ controller }: { controller: EditorController }) {
  const [color, setColor] = useState("#11181c")
  const [highlight, setHighlight] = useState("#fff1a8")
  const [open, setOpen] = useState(false)
  const allowed = controller.ready && controller.canEdit
  const { trigger, theme, inherit } = useToolbarTheme()
  return <Popover.Root open={open && allowed} onOpenChange={next => { if (!allowed) return; setOpen(next); if (next) inherit() }}>
    <Toolbar.Button ref={trigger} render={<Popover.Trigger/>} className="ow-editor-control ow-editor-icon-control" disabled={!controller.ready || !controller.canEdit} aria-label="Text and highlight colors" title="Text and highlight colors"><Palette size={16} aria-hidden/></Toolbar.Button>
    <Popover.Portal keepMounted={open && !allowed} hidden={!allowed} inert={!allowed} style={!allowed ? { display: "none" } : undefined}><Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="ow-editor-positioner">
      <Popover.Popup className="ow-editor-menu ow-editor-colors" style={theme} aria-label="Text and highlight colors">
        <label><Palette size={15} aria-hidden/><span>Text color</span><input type="color" aria-label="Text color" value={color} onChange={event => { setColor(event.target.value); controller.execute({ type: "color", value: event.target.value }) }}/></label>
        <label><Highlighter size={15} aria-hidden/><span>{controller.kind === "spreadsheet" ? "Cell background" : "Highlight"}</span><input type="color" aria-label={controller.kind === "spreadsheet" ? "Cell background" : "Highlight color"} value={highlight} onChange={event => { setHighlight(event.target.value); controller.execute({ type: "highlight", value: event.target.value }) }}/></label>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>
}

const action = (label: string, value: EditorAction): MenuOption => ({ label, command: { type: "action", action: value } })
const alignmentIcons = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify }

/** The OpenWork editing surface: compact commands with advanced tools on demand. */
export function DocumentToolbar({ controller }: { controller: EditorController }) {
  const { selection, kind } = controller
  const Alignment = alignmentIcons[selection.alignment ?? "left"]
  const styles = ["Default Paragraph Style", "Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3"]
  const fonts = ["Arial", "Calibri", "Cambria", "Georgia", "Helvetica", "Times New Roman", "Verdana"]
  const format = kind === "spreadsheet" ? [action("Format cells…", "format-cells"), action("Merge cells", "merge-cells"), action("Sort ascending", "sort-ascending"), action("Sort descending", "sort-descending"), action("Filter", "filter")]
    : kind === "presentation" ? [action("Speaker notes", "slide-notes"), action("Slide view", "slide-view"), action("Strikethrough", "strikethrough"), action("Clear formatting", "clear-formatting")]
    : [action("Paragraph…", "format-paragraph"), action("Page layout…", "page-layout"), action("Strikethrough", "strikethrough"), action("Increase indent", "indent"), action("Decrease indent", "outdent"), action("Clear formatting", "clear-formatting")]
  const insert = kind === "spreadsheet" ? [action("Insert row above", "insert-row"), action("Insert column before", "insert-column"), action("Add comment", "insert-comment"), action("Insert link…", "insert-link")]
    : kind === "presentation" ? [action("Text box", "text-box"), action("Insert link…", "insert-link"), action("Add comment", "insert-comment")]
    : [{ label: "Table (3 × 3)", command: { type: "table", rows: 3, columns: 3 } } satisfies MenuOption, action("Insert link…", "insert-link"), action("Add comment", "insert-comment"), action("Page break", "page-break")]
  if (controller.notice) return <div className="ow-editor-message" role="status">{controller.notice}</div>
  return <Toolbar.Root className="ow-document-commandbar" aria-label={kind === "spreadsheet" ? "Spreadsheet formatting" : kind === "presentation" ? "Slide formatting" : "Document formatting"}>
    <Toolbar.Group className="ow-editor-control-group" aria-label="History">
      <EditorToolbarButton label="Undo" action="undo" controller={controller} disabled={selection.canUndo === false}><Undo2 size={16}/></EditorToolbarButton>
      <EditorToolbarButton label="Redo" action="redo" controller={controller} disabled={selection.canRedo === false}><Redo2 size={16}/></EditorToolbarButton>
    </Toolbar.Group>
    <Toolbar.Separator className="ow-editor-control-separator"/>
    {kind === "document" ? <EditorToolbarMenu label="Paragraph style" controller={controller} className="ow-editor-style-control" options={styles.map(value => ({ label: value === "Default Paragraph Style" ? "Normal text" : value, checked: value === selection.style, command: { type: "style", value } }))}>{selection.style === "Default Paragraph Style" ? "Normal text" : selection.style || "Style"}</EditorToolbarMenu>
      : kind === "presentation" ? <><EditorToolbarMenu label="Slide" controller={controller} options={[action("New slide", "new-slide"), action("Duplicate slide", "duplicate-slide"), action("Delete slide", "delete-slide")]}>Slide</EditorToolbarMenu><EditorToolbarMenu label="Slide layout" controller={controller} options={[
        { label: "Title slide", command: { type: "slide-layout", value: "title" } }, { label: "Title and content", command: { type: "slide-layout", value: "content" } },
        { label: "Two columns", command: { type: "slide-layout", value: "two-columns" } }, { label: "Title only", command: { type: "slide-layout", value: "title-only" } }, { label: "Blank", command: { type: "slide-layout", value: "blank" } },
      ]}>Layout</EditorToolbarMenu></>
      : <EditorToolbarMenu label="Number format" controller={controller} options={[action("Number", "number"), action("Currency", "currency"), action("Percent", "percent"), action("More formats…", "format-cells")]}>Number</EditorToolbarMenu>}
    <EditorToolbarMenu label="Font" controller={controller} className="ow-editor-font-control" options={fonts.map(value => ({ label: value, checked: value === selection.font, command: { type: "font", value } }))}>{selection.font || "Font"}</EditorToolbarMenu>
    <EditorToolbarMenu label="Font size" controller={controller} options={[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map(value => ({ label: String(value), checked: value === selection.fontSize, command: { type: "font-size", value } }))}>{selection.fontSize || "Size"}</EditorToolbarMenu>
    <Toolbar.Separator className="ow-editor-control-separator"/>
    <Toolbar.Group className="ow-editor-control-group" aria-label="Text formatting">
      <EditorToolbarButton label="Bold" action="bold" controller={controller} pressed={selection.bold}><Bold size={16}/></EditorToolbarButton>
      <EditorToolbarButton label="Italic" action="italic" controller={controller} pressed={selection.italic}><Italic size={16}/></EditorToolbarButton>
      <EditorToolbarButton label="Underline" action="underline" controller={controller} pressed={selection.underline}><Underline size={16}/></EditorToolbarButton>
      <ColorControls controller={controller}/>
    </Toolbar.Group>
    <Toolbar.Separator className="ow-editor-control-separator"/>
    <EditorToolbarMenu label="Text alignment" controller={controller} options={[
      { ...action("Align left", "align-left"), checked: selection.alignment === "left", icon: <AlignLeft size={15}/> },
      { ...action("Center", "align-center"), checked: selection.alignment === "center", icon: <AlignCenter size={15}/> },
      { ...action("Align right", "align-right"), checked: selection.alignment === "right", icon: <AlignRight size={15}/> },
      { ...action("Justify", "align-justify"), checked: selection.alignment === "justify", icon: <AlignJustify size={15}/> },
    ]}><Alignment size={16}/></EditorToolbarMenu>
    {kind !== "spreadsheet" && <Toolbar.Group className="ow-editor-control-group" aria-label="Lists"><EditorToolbarButton label="Bullet list" action="bullet-list" controller={controller}><List size={16}/></EditorToolbarButton><EditorToolbarButton label="Numbered list" action="numbered-list" controller={controller}><ListOrdered size={16}/></EditorToolbarButton></Toolbar.Group>}
    <Toolbar.Separator className="ow-editor-control-separator"/>
    <EditorToolbarMenu label="Insert" controller={controller} options={insert}>Insert</EditorToolbarMenu>
    <EditorToolbarMenu label="Format" controller={controller} options={format}>Format</EditorToolbarMenu>
    <span className="ow-editor-control-space"/>
    <EditorToolbarButton label="Find and replace" action="find" controller={controller}><Search size={16}/></EditorToolbarButton>
    {kind === "presentation" && <EditorToolbarButton label="Present slides" action="present" controller={controller}><Play size={16}/></EditorToolbarButton>}
    <Toolbar.Button className="ow-editor-control" disabled={!controller.ready} aria-label="More editing tools" aria-pressed={controller.advanced} title="More editing tools" onClick={() => controller.setAdvanced(!controller.advanced)}><SlidersHorizontal size={16} aria-hidden/><span className="ow-editor-tools-label">More tools</span><MoreHorizontal size={14} aria-hidden/></Toolbar.Button>
  </Toolbar.Root>
}
