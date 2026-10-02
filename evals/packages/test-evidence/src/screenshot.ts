import { createHash } from "node:crypto";
import { callFunction, captureScreenshot, evaluate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { currentTestEvidence } from "./ambient.ts";
import type { EvidenceCheckpoint } from "@openwork/freestyle/checkpoint-schema";
import type { EvidenceBox } from "./screen-change.ts";

export interface ScreenshotArtifact {
  png: Buffer;
  hash: string;
  route: string;
  visibleText: string;
  /** Only the text inside the captured window, so "shows …" never names a line scrolled out of the image. */
  viewportText?: string;
  at: string;
  /** CSS pixel size of the page when it was captured; places `focus` boxes on the image. */
  viewport?: { width: number; height: number };
  /** How long the screen took to stop changing before capture; `settled: false` means it never did within the limit. */
  settle?: { ms: number; settled: boolean };
  /** Set only on images taken by `takeCheckpoint`; plain screenshots never save one. */
  checkpoint?: EvidenceCheckpoint;
  /** "exact" when the screen did not change while the checkpoint was captured. */
  checkpointMatch?: "exact" | "approximate";
  checkpointError?: string;
}

/** An element the test verified on screen, outlined where a reviewer should look. */
export interface EvidenceFocus {
  label: string;
  box: EvidenceBox;
}

/** How a screenshot is recorded as evidence. */
export interface RecordScreenshotOptions {
  caption?: string;
  focus?: EvidenceFocus[];
  /** The screen when a step failed, taken by the runtime rather than the spec. */
  failure?: boolean;
}

export interface ScreenshotOptions extends Omit<RecordScreenshotOptions, "focus"> {
  /** Finds the elements to outline once the screen has settled, in CSS pixels. */
  locateFocus?: () => Promise<{ label: string; rect: { x: number; y: number; width: number; height: number } }[]>;
}

/** A screenshot waits for this much DOM silence, but never longer than the limit. */
const QUIET_MS = 200;
const SETTLE_LIMIT_MS = 1_500;
const CARET_STYLE_ID = "openwork-evidence-hide-caret";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Captures the surface without recording it as evidence. */
export async function captureFrame(app: Surface): Promise<ScreenshotArtifact> {
  const at = new Date().toISOString();
  const png = await captureScreenshot(app.client);
  const page = await evaluate(app.client, () => {
    // The lines a reader can see in the image: text inside the window and inside
    // every scrolling or clipping container around it, one line per block.
    const viewportText = (): string | null => {
      try {
        const clips = new Map<Element, { left: number; top: number; right: number; bottom: number } | null>();
        const clipOf = (element: Element | null): { left: number; top: number; right: number; bottom: number } | null => {
          if (!element) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
          const cached = clips.get(element);
          if (cached !== undefined) return cached;
          const outer = clipOf(element.parentElement);
          let clip = outer;
          const style = getComputedStyle(element);
          if (outer && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
            const rect = element.getBoundingClientRect();
            const left = Math.max(outer.left, rect.left);
            const top = Math.max(outer.top, rect.top);
            const right = Math.min(outer.right, rect.right);
            const bottom = Math.min(outer.bottom, rect.bottom);
            clip = right > left && bottom > top ? { left, top, right, bottom } : null;
          }
          clips.set(element, clip);
          return clip;
        };
        const blocks = new Map<Element, Element>();
        const blockOf = (element: Element): Element => {
          const cached = blocks.get(element);
          if (cached) return cached;
          const display = getComputedStyle(element).display;
          const block = (display.startsWith("inline") || display === "contents") && element.parentElement ? blockOf(element.parentElement) : element;
          blocks.set(element, block);
          return block;
        };
        const lines = new Map<Element, string[]>();
        const range = document.createRange();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
          const parent = node.parentElement;
          if (!text || !parent || !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
          const clip = clipOf(parent);
          if (!clip) continue;
          range.selectNodeContents(node);
          const seen = [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0
            && rect.right > clip.left && rect.left < clip.right && rect.bottom > clip.top && rect.top < clip.bottom);
          if (!seen) continue;
          const block = blockOf(parent);
          const parts = lines.get(block);
          if (parts) parts.push(text);
          else lines.set(block, [text]);
        }
        return [...lines.values()].map((parts) => parts.join(" ")).join("\n");
      } catch {
        return null;
      }
    };
    return {
      route: window.location.hash,
      visibleText: document.body.innerText,
      viewportText: viewportText(),
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  if (!isRecord(page) || typeof page.route !== "string" || typeof page.visibleText !== "string") {
    throw new Error("CDP did not return the current route and visible text for the screenshot.");
  }
  return {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: page.route,
    visibleText: page.visibleText,
    ...(typeof page.viewportText === "string" ? { viewportText: page.viewportText } : {}),
    at,
    ...(typeof page.width === "number" && typeof page.height === "number" && page.width > 0 && page.height > 0
      ? { viewport: { width: page.width, height: page.height } }
      : {}),
  };
}

/**
 * Waits until the page stops changing, so a screenshot shows where an action
 * landed rather than a frame of it: no DOM change for 200 ms and no finite
 * animation or transition still running. Endless animations (spinners) are
 * part of the state being shown, so they never hold it up. Returns after 1.5 s
 * either way, and hides the text caret until `showCaret` so its blink is not
 * mistaken for a change between screenshots.
 */
export async function settleScreen(app: Surface): Promise<{ ms: number; settled: boolean }> {
  try {
    const value = await callFunction(app.client, async (quietMs, limitMs, styleId) => {
      const started = performance.now();
      let last = started;
      const observer = new MutationObserver(() => { last = performance.now(); });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const finishing = () => document.getAnimations().some((animation) => {
        if (animation.playState !== "running") return false;
        const end = animation.effect?.getComputedTiming().endTime;
        return typeof end === "number" && Number.isFinite(end);
      });
      try {
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const now = performance.now();
          if (now - last >= quietMs && !finishing()) return { ms: Math.round(now - started), settled: true };
          if (now - started >= limitMs) return { ms: Math.round(now - started), settled: false };
        }
      } finally {
        observer.disconnect();
        if (!document.getElementById(styleId)) {
          const style = document.createElement("style");
          style.id = styleId;
          style.textContent = "*,*::before,*::after{caret-color:transparent!important}";
          document.head.append(style);
        }
      }
    }, [QUIET_MS, SETTLE_LIMIT_MS, CARET_STYLE_ID], { awaitPromise: true, timeoutMs: SETTLE_LIMIT_MS + 3_000 });
    if (isRecord(value) && typeof value.ms === "number" && typeof value.settled === "boolean") return { ms: value.ms, settled: value.settled };
  } catch {
    // A page that cannot be observed is still captured as it is.
  }
  return { ms: 0, settled: false };
}

export async function showCaret(app: Surface): Promise<void> {
  await callFunction(app.client, (styleId) => { document.getElementById(styleId)?.remove(); }, [CARET_STYLE_ID]).catch(() => undefined);
}

/** Places CSS-pixel rectangles on the image as fractions, dropping any that fall outside it. */
export function focusBoxes(
  found: { label: string; rect: { x: number; y: number; width: number; height: number } }[],
  viewport: ScreenshotArtifact["viewport"],
): EvidenceFocus[] {
  if (!viewport) return [];
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return found.flatMap(({ label, rect }) => {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(viewport.width, rect.x + rect.width);
    const y1 = Math.min(viewport.height, rect.y + rect.height);
    if (x1 - x0 < 1 || y1 - y0 < 1) return [];
    return [{ label, box: { x: round(x0 / viewport.width), y: round(y0 / viewport.height), width: round((x1 - x0) / viewport.width), height: round((y1 - y0) / viewport.height) } }];
  });
}

export async function screenshot(app: Surface, options: ScreenshotOptions = {}): Promise<ScreenshotArtifact> {
  const { locateFocus, ...recordOptions } = options;
  const settle = await settleScreen(app);
  let artifact: ScreenshotArtifact;
  let found: Awaited<ReturnType<NonNullable<ScreenshotOptions["locateFocus"]>>> = [];
  try {
    found = locateFocus ? await locateFocus().catch(() => []) : [];
    artifact = { ...await captureFrame(app), settle };
  } finally {
    await showCaret(app);
  }
  const focus = focusBoxes(found, artifact.viewport);
  currentTestEvidence()?.recordScreenshot(artifact, { ...recordOptions, ...(focus.length > 0 ? { focus } : {}) });
  return artifact;
}
