/**
 * The progressive blur behind the floating header (`top`) or message box (`bottom`): a tint and four blur layers,
 * each stronger and masked to a shorter band at the screen's edge (styles.css, `.workbot-glass`). Text passing under
 * it softens gradually instead of meeting a hard line. Decoration only: no pointer events, hidden from assistive tech.
 */
export function FloatingGlass({ edge }: { edge: "top" | "bottom" }) {
  return <span aria-hidden className="workbot-glass" data-edge={edge} data-workbot-glass={edge}><i /><i /><i /><i /><i /></span>;
}
