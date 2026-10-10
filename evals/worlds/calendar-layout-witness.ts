import type { Surface } from "@openwork/cdp";
import { isRecord } from "./library.ts";

async function nodeFor(surface: Surface, selector: string) {
  const document = await surface.client.send("DOM.getDocument");
  if (!isRecord(document) || !isRecord(document.root) || typeof document.root.nodeId !== "number") throw new Error("Missing document");
  const node = await surface.client.send("DOM.querySelector", { nodeId: document.root.nodeId, selector });
  if (!isRecord(node) || typeof node.nodeId !== "number" || node.nodeId === 0) throw new Error(`Missing ${selector}`);
  return node.nodeId;
}

async function styleFor(surface: Surface, nodeId: number) {
  const style = await surface.client.send("CSS.getComputedStyleForNode", { nodeId });
  if (!isRecord(style) || !Array.isArray(style.computedStyle)) throw new Error("Missing computed styles");
  const values = new Map<string, string>();
  for (const property of style.computedStyle) {
    if (isRecord(property) && typeof property.name === "string" && typeof property.value === "string") values.set(property.name, property.value);
  }
  return values;
}

/** Read-only CSS protocol observation, because probe.dom intentionally does not expose color/overflow. */
export async function readCalendarStyle(surface: Surface, selector: string) {
  return styleFor(surface, await nodeFor(surface, selector));
}

function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
  if (!color.startsWith("rgb") || channels.length < 3 || (channels.length === 4 && channels[3] !== 1)) throw new Error(`Expected opaque computed RGB, got ${color}`);
  const linear = channels.slice(0, 3).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** The hour label's actual ink and nearest painted ancestor; no page evaluation or style overrides. */
export async function readCalendarRail(surface: Surface) {
  // getFlattenedDocument rebuilds the inspector's node ids, so read the tree first and query the label within that same snapshot.
  const flattened = await surface.client.send("DOM.getFlattenedDocument", { depth: -1 });
  if (!isRecord(flattened) || !Array.isArray(flattened.nodes)) throw new Error("Missing ancestor tree");
  const nodes = new Map<number, { parent: number; element: boolean }>();
  let rootId = 0;
  for (const node of flattened.nodes) {
    if (!isRecord(node) || typeof node.nodeId !== "number") continue;
    nodes.set(node.nodeId, { parent: typeof node.parentId === "number" ? node.parentId : 0, element: node.nodeType === 1 });
    if (node.nodeType === 9 && typeof node.parentId !== "number" && rootId === 0) rootId = node.nodeId;
  }
  if (rootId === 0) throw new Error("Missing document in ancestor tree");
  const found = await surface.client.send("DOM.querySelector", { nodeId: rootId, selector: '[data-calendar-hour="8"]' });
  if (!isRecord(found) || typeof found.nodeId !== "number" || found.nodeId === 0) throw new Error('Missing [data-calendar-hour="8"]');
  const labelId = found.nodeId;
  const label = await styleFor(surface, labelId);
  let ancestor = labelId;
  let background = "";
  while (ancestor > 0) {
    const node = nodes.get(ancestor);
    if (!node) throw new Error("Hour label lost its ancestor tree");
    if (node.element) {
      const color = (await styleFor(surface, ancestor)).get("background-color") ?? "";
      if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") { background = color; break; }
    }
    ancestor = node.parent;
  }
  const foreground = label.get("color") ?? "";
  const light = luminance(background);
  const dark = luminance(foreground);
  return { foreground, background, fontSize: Number.parseFloat(label.get("font-size") ?? "0"), contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
}
