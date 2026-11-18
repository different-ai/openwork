// The computer view, popped out of the chat into its own always-on-top window
// (allowed for this name only by the desktop's window-open handler). The chat's
// renderer still owns the view: it portals into the new window's document, which
// mirrors this document's styles and theme so it reads like the in-chat card.

export const COMPUTER_POPOUT_PREFIX = "openwork-computer-view-"
let opened = 0

export type ComputerPopout = { window: Window; dispose: () => void }

export function openComputerPopout(bounds: { left: number; top: number; width: number; height: number }): ComputerPopout | null {
  const features = ["popup", ...Object.entries(bounds).map(([key, value]) => `${key}=${Math.round(value)}`)].join(",")
  const child = window.open("about:blank", `${COMPUTER_POPOUT_PREFIX}${++opened}`, features)
  if (!child) return null
  const target = child.document

  const mirrorRoot = () => {
    for (const { name } of Array.from(target.documentElement.attributes)) target.documentElement.removeAttribute(name)
    for (const { name, value } of Array.from(document.documentElement.attributes)) target.documentElement.setAttribute(name, value)
  }
  const mirrorStyles = () => {
    target.head.querySelectorAll("[data-computer-popout-style]").forEach((node) => node.remove())
    for (const node of Array.from(document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>("link[rel='stylesheet'], style"))) {
      const copy = target.createElement(node.tagName.toLowerCase()) as HTMLLinkElement | HTMLStyleElement
      if (node instanceof HTMLLinkElement) { (copy as HTMLLinkElement).rel = "stylesheet"; (copy as HTMLLinkElement).href = node.href }
      else copy.textContent = node.textContent
      copy.setAttribute("data-computer-popout-style", "")
      target.head.append(copy)
    }
  }
  target.title = "Computer"
  mirrorRoot()
  mirrorStyles()
  target.body.className = "m-0 overflow-hidden bg-popover"

  // Theme switches and development style reloads follow the chat while popped out.
  const root = new MutationObserver(mirrorRoot)
  root.observe(document.documentElement, { attributes: true })
  const styles = new MutationObserver(mirrorStyles)
  styles.observe(document.head, { childList: true, subtree: true, characterData: true })
  const closeWithChat = () => child.close()
  window.addEventListener("pagehide", closeWithChat)

  return {
    window: child,
    dispose: () => {
      root.disconnect()
      styles.disconnect()
      window.removeEventListener("pagehide", closeWithChat)
      if (!child.closed) child.close()
    },
  }
}
