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

type Rgba = { r: number; g: number; b: number; a: number };

/** Computed colors arrive as rgb()/rgba() or, for color-mix and opacity utilities, oklab(); all become sRGB 0–1. */
function parseColor(color: string): Rgba {
  // Read only the channel list, so the "3" in "display-p3" is not taken for a channel.
  const list = color.startsWith("color(") ? color.slice(color.indexOf(" ") + 1) : color.slice(color.indexOf("(") + 1);
  const channels = list.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? [];
  if (color.startsWith("rgb") && channels.length >= 3) {
    return { r: channels[0]! / 255, g: channels[1]! / 255, b: channels[2]! / 255, a: channels[3] ?? 1 };
  }
  if (color.startsWith("oklab(") && channels.length >= 3) {
    const [lightness, a, b] = channels;
    const l = (lightness! + 0.3963377774 * a! + 0.2158037573 * b!) ** 3;
    const m = (lightness! - 0.1055613458 * a! - 0.0638541728 * b!) ** 3;
    const s = (lightness! - 0.0894841775 * a! - 1.291485548 * b!) ** 3;
    const encode = (value: number) => {
      const clamped = Math.min(1, Math.max(0, value));
      return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    };
    return {
      r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
      a: channels[3] ?? 1,
    };
  }
  if (color.startsWith("color(srgb ") && channels.length >= 3) {
    return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: channels[3] ?? 1 };
  }
  if (color.startsWith("color(display-p3 ") && channels.length >= 3) {
    // Display P3 shares sRGB's transfer curve; convert its linear primaries to linear sRGB.
    const decode = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    const encode = (value: number) => {
      const clamped = Math.min(1, Math.max(0, value));
      return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    };
    const [r, g, b] = channels.slice(0, 3).map(decode);
    return {
      r: encode(1.2249401 * r! - 0.2249404 * g!),
      g: encode(-0.0420569 * r! + 1.0420571 * g!),
      b: encode(-0.0196376 * r! - 0.0786361 * g! + 1.0982735 * b!),
      a: channels[3] ?? 1,
    };
  }
  throw new Error(`Unsupported computed color ${color}`);
}

/** Source-over: a translucent layer painted on an opaque one below it. */
function over(top: Rgba, below: Rgba): Rgba {
  return { r: top.r * top.a + below.r * (1 - top.a), g: top.g * top.a + below.g * (1 - top.a), b: top.b * top.a + below.b * (1 - top.a), a: 1 };
}

function luminance(color: Rgba): number {
  const linear = [color.r, color.g, color.b].map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

const describe = (color: Rgba) => `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;

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
  // Composite every translucent background between the label and the first opaque one, as the browser paints them.
  let ancestor = labelId;
  const layers: Rgba[] = [];
  let backdrop: Rgba | null = null;
  while (ancestor > 0) {
    const node = nodes.get(ancestor);
    if (!node) throw new Error("Hour label lost its ancestor tree");
    if (node.element) {
      const color = (await styleFor(surface, ancestor)).get("background-color") ?? "";
      if (color !== "" && color !== "transparent") {
        const parsed = parseColor(color);
        if (parsed.a >= 1) { backdrop = parsed; break; }
        if (parsed.a > 0) layers.push(parsed);
      }
    }
    ancestor = node.parent;
  }
  if (!backdrop) throw new Error("Hour label has no opaque painted background");
  const background = layers.reduceRight((below, layer) => over(layer, below), backdrop);
  const ink = parseColor(label.get("color") ?? "");
  const foreground = ink.a >= 1 ? ink : over(ink, background);
  const light = luminance(background);
  const dark = luminance(foreground);
  return { foreground: describe(foreground), background: describe(background), fontSize: Number.parseFloat(label.get("font-size") ?? "0"), contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
}
