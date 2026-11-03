// Remembers the main window's size, position and maximized state, so the app
// reopens where it was closed instead of centered at the default size.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WINDOW_STATE_FILENAME = "window-state.json";
const WINDOW_STATE_VERSION = 1;
const SAVE_DELAY_MS = 500;
// A restored window must show at least this much of its top edge on some
// display, so the title bar can always be grabbed.
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 40;

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ bounds: Rect, maximized: boolean }} WindowState
 */

/** @param {unknown} value @returns {value is number} */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value @returns {Rect | null} */
function parseRect(value) {
  if (!value || typeof value !== "object") return null;
  const x = Reflect.get(value, "x");
  const y = Reflect.get(value, "y");
  const width = Reflect.get(value, "width");
  const height = Reflect.get(value, "height");
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** @param {unknown} value @returns {WindowState | null} */
export function parseWindowState(value) {
  if (!value || typeof value !== "object") return null;
  if (Reflect.get(value, "version") !== WINDOW_STATE_VERSION) return null;
  const bounds = parseRect(Reflect.get(value, "bounds"));
  if (!bounds) return null;
  return { bounds, maximized: Reflect.get(value, "maximized") === true };
}

/** @param {Rect} a @param {Rect} b */
function overlap(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Fits saved bounds onto the displays connected now. Returns null when the
 * window's title bar would not be reachable on any display (for example the
 * monitor it was on is unplugged), so the caller falls back to the default.
 * Otherwise the size is shrunk to the display's work area if needed and the
 * window is moved fully onto it.
 *
 * @param {Rect} bounds
 * @param {Rect[]} workAreas
 * @param {{ minWidth?: number, minHeight?: number }} [limits]
 * @returns {Rect | null}
 */
export function fitBoundsToDisplays(bounds, workAreas, limits = {}) {
  const titleStrip = { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.min(bounds.height, MIN_VISIBLE_HEIGHT) };
  let best = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const strip = overlap(titleStrip, area);
    if (strip.width < Math.min(MIN_VISIBLE_WIDTH, bounds.width) || strip.height < Math.min(MIN_VISIBLE_HEIGHT, bounds.height) / 2) continue;
    const shared = overlap(bounds, area);
    const sharedArea = shared.width * shared.height;
    if (!best || sharedArea > bestArea) {
      best = area;
      bestArea = sharedArea;
    }
  }
  if (!best) return null;

  const width = Math.max(Math.min(bounds.width, best.width), Math.min(limits.minWidth ?? 0, best.width));
  const height = Math.max(Math.min(bounds.height, best.height), Math.min(limits.minHeight ?? 0, best.height));
  const x = Math.min(Math.max(bounds.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(bounds.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}

/**
 * @param {{
 *   directory: string,
 *   screen: { getAllDisplays: () => Array<{ workArea: Rect }> },
 *   log?: (message: string, error?: unknown) => void,
 * }} options
 */
export function createWindowStateStore({ directory, screen, log = () => {} }) {
  const filePath = path.join(directory, WINDOW_STATE_FILENAME);

  /** @returns {WindowState | null} */
  function read() {
    try {
      return parseWindowState(JSON.parse(readFileSync(filePath, "utf8")));
    } catch {
      return null;
    }
  }

  /** @param {WindowState} state */
  function write(state) {
    try {
      mkdirSync(directory, { recursive: true });
      const tempPath = `${filePath}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify({ version: WINDOW_STATE_VERSION, ...state })}\n`, "utf8");
      renameSync(tempPath, filePath);
    } catch (error) {
      log("[window-state] could not save window size and position", error);
    }
  }

  /**
   * BrowserWindow options that restore the last size and position, or the
   * defaults when nothing usable was saved.
   *
   * @param {{ width: number, height: number, minWidth?: number, minHeight?: number }} defaults
   */
  function initialOptions(defaults) {
    const saved = read();
    if (!saved) return { options: { width: defaults.width, height: defaults.height }, maximized: false };
    const workAreas = screen.getAllDisplays().map((display) => display.workArea);
    const bounds = fitBoundsToDisplays(saved.bounds, workAreas, defaults);
    if (!bounds) return { options: { width: defaults.width, height: defaults.height }, maximized: saved.maximized };
    return { options: bounds, maximized: saved.maximized };
  }

  /**
   * Saves the window's state as it moves and resizes, and once more when it
   * closes. Uses the normal (unmaximized) bounds so un-maximizing after a
   * restart returns to the size the person chose.
   *
   * @param {import("electron").BrowserWindow} window
   */
  function track(window) {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const capture = () => {
      if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return null;
      return { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    };
    const saveNow = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const state = capture();
      if (state) write(state);
    };
    const saveSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveNow, SAVE_DELAY_MS);
    };
    window.on("resize", saveSoon);
    window.on("move", saveSoon);
    window.on("maximize", saveSoon);
    window.on("unmaximize", saveSoon);
    window.on("close", saveNow);
  }

  return { initialOptions, track, filePath };
}
