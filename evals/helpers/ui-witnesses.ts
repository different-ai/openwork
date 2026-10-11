import { callFunctionOnSurface, evaluateOnSurface, type Surface } from "@openwork/cdp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native, read-only center hit test. Never locate/click/scroll before taking this witness:
 * trusted click lookup can scroll even overflow-hidden ancestors and mask a clipped popup. */
export async function preScrollCenterHitTest(surface: Surface, selector: string, index = 0) {
  const center = await callFunctionOnSurface(surface, (selector, index) => {
    if (typeof selector !== "string" || typeof index !== "number") throw new Error("Expected a selector and index");
    const element = document.querySelectorAll(selector)[index];
    if (!element) throw new Error("Missing hit-test element");
    const rect = element.getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  }, [selector, index]);
  const documentResponse = await surface.client.send("DOM.getDocument", {});
  if (!isRecord(documentResponse) || !isRecord(documentResponse.root) || typeof documentResponse.root.nodeId !== "number") throw new Error("Missing document node");
  const nodes = await surface.client.send("DOM.querySelectorAll", { nodeId: documentResponse.root.nodeId, selector });
  const nodeId = isRecord(nodes) && Array.isArray(nodes.nodeIds) ? nodes.nodeIds[index] : undefined;
  if (typeof nodeId !== "number") throw new Error("Missing hit-test node");
  const expected = await surface.client.send("DOM.describeNode", { nodeId, depth: -1 });
  const hit = await surface.client.send("DOM.getNodeForLocation", { x: Math.round(center.x), y: Math.round(center.y) });
  const backendNodeId = isRecord(hit) && typeof hit.backendNodeId === "number" ? hit.backendNodeId : null;
  const containsHit = (node: unknown): boolean => isRecord(node) && (node.backendNodeId === backendNodeId
    || (Array.isArray(node.children) && node.children.some(containsHit)));
  return { ...center, hitsExpectedElement: backendNodeId !== null && isRecord(expected) && containsHit(expected.node) };
}

/** Base UI Select can retain hidden DOM for typeahead: closure is painted absence,
 * not unmount. Pair this observation with closed trigger/focus and stable user.notSee. */
export function popupPaintState(surface: Surface, popupSelector: string, triggerSelector: string) {
  return callFunctionOnSurface(surface, (popupSelector, triggerSelector) => {
    if (typeof popupSelector !== "string" || typeof triggerSelector !== "string") throw new Error("Expected popup and trigger selectors");
    const trigger = document.querySelector(triggerSelector);
    const lists = Array.from(document.querySelectorAll(popupSelector), (list) => {
      const rect = list.getBoundingClientRect();
      let hiddenBy: string | null = null;
      for (let ancestor: Element | null = list; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) {
          hiddenBy = `${ancestor.tagName.toLowerCase()}: display ${style.display}, visibility ${style.visibility}, opacity ${style.opacity}`;
          break;
        }
      }
      return { width: rect.width, height: rect.height, hiddenBy,
        painted: hiddenBy === null && rect.width > 0 && rect.height > 0
          && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight };
    });
    return { retained: lists.length, painted: lists.filter((list) => list.painted).length, lists,
      triggerExists: trigger !== null, expanded: trigger?.getAttribute("aria-expanded") === "true",
      triggerFocused: trigger === document.activeElement };
  }, [popupSelector, triggerSelector]);
}

/** innerWidth includes a classic scrollbar; compare document overflow with the
 * measured usable clientWidth instead. Does not change viewport or scrollbar policy. */
export function documentOverflow(surface: Surface) {
  return evaluateOnSurface(surface, () => {
    const clientWidth = document.documentElement.clientWidth;
    const documentWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    return { clientWidth, documentWidth, viewportWidth: innerWidth, noSidewaysScroll: documentWidth <= clientWidth };
  });
}
