import { createPortal } from "react-dom"
import { useRef, useState, type ReactNode } from "react"
import { Tooltip } from "@base-ui/react/tooltip"
import { Info } from "lucide-react"

/** One actions row beside the file tabs; standalone hosts can omit the portal target. */
export function EditorActions({ active, host, children }: { active: boolean; host?: HTMLElement | null; children: ReactNode }) {
  if (!active) return null
  const actions = <div className="ow-editor-toolbar" aria-label="Document actions">{children}</div>
  return host ? createPortal(actions, host) : actions
}

/** Keep format details out of the document canvas; Base UI owns focus and placement. */
export function DocumentInformation({ children }: { children: string }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [theme, setTheme] = useState<Partial<Record<`--doc-${string}`, string>>>({})
  return <Tooltip.Provider><Tooltip.Root onOpenChange={open => {
    if (!open || !trigger.current) return
    const style = getComputedStyle(trigger.current)
    setTheme({ "--doc-bg": style.getPropertyValue("--doc-bg"), "--doc-text": style.getPropertyValue("--doc-text"), "--doc-line": style.getPropertyValue("--doc-line") })
  }}>
    <Tooltip.Trigger ref={trigger} type="button" className="ow-document-information" aria-label="Document information"><Info size={16} strokeWidth={1.5} aria-hidden/></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} positionMethod="fixed" className="ow-document-information-positioner">
      <Tooltip.Popup className="ow-document-information-tooltip" style={theme}>{children}</Tooltip.Popup>
    </Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root></Tooltip.Provider>
}
