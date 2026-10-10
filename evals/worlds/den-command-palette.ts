import type { Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { adminDashboardWeb } from "./den-admin-navigation.ts";

const palette = '[data-testid="den-command-palette"]';
const textSelectors = {
  heading: `${palette} [cmdk-group-heading]`,
  hint: `${palette} [cmdk-item]:not([data-selected="true"]) > span:last-child`,
  selectedHint: `${palette} [cmdk-item][data-selected="true"] > span:last-child`,
  empty: `${palette} [cmdk-empty]`,
  footer: '[data-testid="den-command-palette-footer"]',
};

type PaletteText = keyof typeof textSelectors;
type PaletteNode = { parent: number; element: boolean; textNodes: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function color(value: string) {
  if (value === "transparent") return { luminance: 0, alpha: 0 };
  const values = /^rgba?\((.+)\)$/.exec(value)?.[1]?.split(/[,\s/]+/).filter(Boolean).map(Number);
  if (!values || (values.length !== 3 && values.length !== 4) || !values.every(Number.isFinite)) {
    throw new Error(`Expected Den's computed sRGB color, received ${value}.`);
  }
  const [red, green, blue, alpha = 1] = values;
  if (red === undefined || green === undefined || blue === undefined || alpha < 0 || alpha > 1) {
    throw new Error(`Invalid computed color: ${value}.`);
  }
  const linear = (channel: number) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return { luminance: 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue), alpha };
}

async function readPaletteText(surface: Surface, kind: PaletteText) {
  const document = await surface.client.send("DOM.getDocument", { depth: -1 });
  if (!isRecord(document) || !isRecord(document.root) || typeof document.root.nodeId !== "number") {
    throw new Error("The command palette document is not available.");
  }
  const nodes = new Map<number, PaletteNode>();
  function collect(value: unknown, parent: number) {
    if (!isRecord(value) || typeof value.nodeId !== "number") return;
    const children = Array.isArray(value.children) ? value.children : [];
    nodes.set(value.nodeId, {
      parent,
      element: value.nodeType === 1,
      textNodes: children.filter((child) => isRecord(child) && child.nodeType === 3).length,
    });
    for (const child of children) collect(child, value.nodeId);
  }
  collect(document.root, 0);
  const selected = await surface.client.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: textSelectors[kind] });
  if (!isRecord(selected) || typeof selected.nodeId !== "number" || selected.nodeId === 0) {
    throw new Error(`The command palette's ${kind} has not rendered.`);
  }
  const nodeId = selected.nodeId;
  const styles = new Map<number, Map<string, string>>();
  async function styleFor(id: number) {
    const cached = styles.get(id);
    if (cached) return cached;
    const result = await surface.client.send("CSS.getComputedStyleForNode", { nodeId: id });
    if (!isRecord(result) || !Array.isArray(result.computedStyle)) throw new Error("Missing palette computed styles.");
    const style = new Map<string, string>();
    for (const property of result.computedStyle) {
      if (isRecord(property) && typeof property.name === "string" && typeof property.value === "string") {
        style.set(property.name, property.value);
      }
    }
    styles.set(id, style);
    return style;
  }
  const text = await styleFor(nodeId);
  const foreground = text.get("color") ?? "";
  const ink = color(foreground);
  if (ink.alpha !== 1) throw new Error("Palette contrast needs opaque text ink.");
  let background = "";
  let backgroundLuminance: number | undefined;
  for (let ancestor = nodeId; ancestor > 0;) {
    const node = nodes.get(ancestor);
    if (!node) throw new Error("The palette text lost its ancestor tree.");
    if (node.element) {
      const style = await styleFor(ancestor);
      if (Number(style.get("opacity")) !== 1) throw new Error("Palette contrast needs fully opaque ancestors.");
      if (backgroundLuminance === undefined) {
        if (style.get("background-image") !== "none") throw new Error("Palette text has an unmeasured background image.");
        const fill = style.get("background-color") ?? "";
        const paint = color(fill);
        if (paint.alpha !== 0 && paint.alpha !== 1) throw new Error("Palette contrast needs an opaque painted background.");
        if (paint.alpha === 1) {
          background = fill;
          backgroundLuminance = paint.luminance;
        }
      }
    }
    ancestor = node.parent;
  }
  if (backgroundLuminance === undefined) throw new Error("The palette text has no painted background.");
  return {
    foreground,
    background,
    contrast: (Math.max(ink.luminance, backgroundLuminance) + 0.05) / (Math.min(ink.luminance, backgroundLuminance) + 0.05),
    fontSize: Number.parseFloat(text.get("font-size") ?? "0"),
    textTransform: text.get("text-transform"),
    letterSpacing: text.get("letter-spacing"),
    textNodes: nodes.get(nodeId)?.textNodes ?? 0,
  };
}

/** Compose the existing real Den journey; do not alter its shared navigation world. */
export async function denCommandPalette(seed: Seed) {
  const world = await adminDashboardWeb(seed);
  await world.web.client.send("DOM.enable");
  await world.web.client.send("CSS.enable");
  return {
    ...world,
    // TODO(primitive): probe.dom has geometry but not colors or typography.
    // This fixed, read-only CSS/DOM protocol witness reads the real text and its
    // nearest painted ancestor (including selected rows). No evaluation, markup,
    // style injection, product imports, or measurement-classifier changes.
    textAppearance: (kind: PaletteText) => readPaletteText(world.web, kind),
  };
}

export type PaletteTextAppearance = Awaited<ReturnType<typeof readPaletteText>>;
