"use client";

import { z } from "zod";

const tabSchema = z.object({ id: z.string(), url: z.string(), title: z.string() });
// Everything but the address and title is absent from computers built before it.
const pageSchema = z.object({
  type: z.literal("page"), id: z.string().optional(), url: z.string(), title: z.string(),
  loading: z.boolean().optional(), back: z.boolean().optional(), forward: z.boolean().optional(),
  tabs: z.array(tabSchema).optional(),
});
const clipboardSchema = z.object({ type: z.literal("clipboard"), text: z.string() });
export type ScreencastTab = z.infer<typeof tabSchema>;
export type ScreencastPage = Omit<z.infer<typeof pageSchema>, "type">;

/**
 * Draws the browser's front tab from the computer's screencast: JPEG frames over a WebSocket, each acknowledged once
 * drawn so the computer never queues more than the connection can show. It fires the events Workbot listens for on
 * noVNC ("connect" once the first frame is on screen, "disconnect" when the stream ends) plus "page" with the tab's
 * address, title, loading state, history and open tabs, since a page stream has no browser toolbar. The viewer can
 * switch and close those tabs; with `control` it also sends the person's pointer, wheel, keys and pasted text to the
 * page, copies the page's selected text out, and can open tabs, go to an address, and go back, forward or reload.
 */
export class ScreencastViewer extends EventTarget {
  private readonly socket: WebSocket;
  private readonly canvas = document.createElement("canvas");
  /** With control, the keyboard: a hidden text field, so typing methods, dead keys and paste work as they do anywhere. */
  private readonly keyboard: HTMLTextAreaElement | null = null;
  private drawing = Promise.resolve();
  private drawn = false;
  private ended = false;
  private copied: ((text: string) => void) | null = null;
  /** The latest address and title the stream reported. */
  page: ScreencastPage | null = null;

  constructor(target: HTMLElement, url: string, { control = false }: { control?: boolean } = {}) {
    super();
    // The page sits right under the toolbar, as in a browser, with any spare room below or at the sides.
    this.canvas.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;object-position:50% 0;outline:none";
    target.append(this.canvas);
    if (control) this.keyboard = forwardInput(target, this.canvas, (message) => this.send(message), () => this.copy());
    this.socket = new WebSocket(url);
    this.socket.binaryType = "blob";
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        let payload: unknown;
        try { payload = JSON.parse(event.data); } catch { return; }
        const clipboard = clipboardSchema.safeParse(payload);
        if (clipboard.success) { this.copied?.(clipboard.data.text); this.copied = null; return; }
        const page = pageSchema.safeParse(payload);
        if (!page.success) return;
        const { type: _, ...detail } = page.data;
        this.page = detail;
        this.dispatchEvent(new CustomEvent<ScreencastPage>("page", { detail }));
        return;
      }
      const frame = event.data as Blob;
      this.drawing = this.drawing.then(() => this.draw(frame)).catch(() => this.disconnect());
    });
    this.socket.addEventListener("close", () => this.end());
    this.socket.addEventListener("error", () => this.end());
  }

  /** Whether a frame reached the screen; a stream that ends before one never connected. */
  get connected() { return this.drawn; }

  /** Whether this stream takes the person's input. */
  get control() { return this.keyboard !== null; }

  disconnect() { this.socket.close(); this.end(); }

  /** Puts the keyboard on the page, for typing into it with control. */
  focus() { (this.keyboard ?? this.canvas).focus({ preventScroll: true }); }

  /** Whether the keyboard is on the page. */
  get focused() { return this.keyboard !== null && document.activeElement === this.keyboard; }

  /** Brings one of the browser's open tabs to the front, or closes it. */
  tab(action: "activate" | "close", id: string) { this.send({ type: "tab", action, id }); }

  /** With control: opens a blank tab in front. */
  newTab() { this.send({ type: "tab", action: "new" }); }

  /** With control: loads a web address in the front tab. */
  navigate(url: string) { this.send({ type: "navigate", url }); }

  /** With control: goes back, forward, or reloads the front tab. */
  history(action: "back" | "forward" | "reload") { this.send({ type: "history", action }); }

  private send(message: object) { if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }

  /**
   * Copies the page's selected text to the person's clipboard. The clipboard write starts during the key press, which
   * browsers require, and is filled once the computer answers; with nothing selected the clipboard is left as it was.
   */
  private copy() {
    this.copied?.("");
    const text = new Promise<string>((resolve) => { this.copied = resolve; setTimeout(() => resolve(""), 3_000); });
    this.send({ type: "copy" });
    const blob = text.then((value) => { if (!value) throw new Error("Nothing is selected."); return new Blob([value], { type: "text/plain" }); });
    blob.catch(() => {});
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        void navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).catch(() => {});
        return;
      }
    } catch {
      // Fall through to the plain text write.
    }
    void text.then((value) => (value ? navigator.clipboard?.writeText(value) : undefined)).catch(() => {});
  }

  private async draw(frame: Blob) {
    const image = await createImageBitmap(frame);
    if (this.ended) { image.close(); return; }
    if (this.canvas.width !== image.width || this.canvas.height !== image.height) {
      this.canvas.width = image.width;
      this.canvas.height = image.height;
    }
    this.canvas.getContext("2d")?.drawImage(image, 0, 0);
    image.close();
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send("ack");
    if (!this.drawn) { this.drawn = true; this.dispatchEvent(new Event("connect")); }
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    this.copied?.("");
    this.dispatchEvent(new Event("disconnect"));
  }
}

/**
 * What typing into the address bar opens, as in Chrome: a web address as typed, a bare host (example.com/path) over
 * https, localhost over http, and anything else as a search. Other schemes (file:, javascript:) are searched, not opened.
 */
export function addressFor(typed: string): string | null {
  const value = typed.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) { try { return new URL(value).toString(); } catch { return null; } }
  if (/^localhost(:\d+)?(\/|\?|#|$)/i.test(value)) { try { return new URL(`http://${value}`).toString(); } catch { return null; } }
  if (!/\s/.test(value) && /^[^\s/:]+\.[a-z]{2,}(:\d+)?(\/|\?|#|$)/i.test(value)) {
    try { return new URL(`https://${value}`).toString(); } catch { return null; }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

const ALT = 1, CTRL = 2, META = 4, SHIFT = 8;
const BUTTONS = ["left", "middle", "right", "back", "forward"] as const;
// Clicks this close in time and place count as one double or triple click, as on a desktop.
const MULTI_CLICK_MS = 500, MULTI_CLICK_PX = 5;

const mac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

type Key = { key: string; code: string; keyCode: number; modifiers: number; text: string };

/**
 * The computer's browser runs on Linux, so a Mac's shortcuts are translated to their Linux equivalents: ⌘ works as
 * Ctrl, ⌘←/→ go to the start or end of the line, ⌘↑/↓ to the start or end of the page, and ⌥←/→ and ⌥⌫ work by word.
 */
export function translateKey(event: Pick<KeyboardEvent, "key" | "code" | "keyCode" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"> & { altGraph?: boolean }, onMac: boolean): Key {
  let { key, code } = event;
  let keyCode = event.keyCode & 255;
  let modifiers = (event.altKey ? ALT : 0) | (event.ctrlKey ? CTRL : 0) | (event.metaKey ? META : 0) | (event.shiftKey ? SHIFT : 0);
  if (onMac) {
    if (key === "Meta") { key = "Control"; code = code === "MetaRight" ? "ControlRight" : "ControlLeft"; keyCode = 17; }
    const command = event.metaKey, option = event.altKey;
    modifiers &= ~META;
    if (command) {
      modifiers |= CTRL;
      if (key === "ArrowLeft" || key === "ArrowRight") { modifiers &= ~CTRL; [key, code, keyCode] = key === "ArrowLeft" ? ["Home", "Home", 36] : ["End", "End", 35]; }
      else if (key === "ArrowUp" || key === "ArrowDown") [key, code, keyCode] = key === "ArrowUp" ? ["Home", "Home", 36] : ["End", "End", 35];
    } else if (option && ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(key)) {
      modifiers = (modifiers & ~ALT) | CTRL;
    }
  }
  // A character typed without a shortcut modifier is text; ⌥ on a Mac types characters (å, ©) rather than shortcuts,
  // and so does AltGr elsewhere, which browsers report as Ctrl+Alt.
  const character = [...key].length === 1;
  if (character && event.altGraph) modifiers &= ~(CTRL | ALT);
  const shortcut = (modifiers & CTRL) !== 0 || (!onMac && (modifiers & (ALT | META)) !== 0);
  const text = key === "Enter" ? "\r" : character && !shortcut ? key : "";
  if (character && !shortcut && onMac) modifiers &= ~ALT;
  return { key, code, keyCode, modifiers, text };
}

/**
 * Sends the person's pointer, wheel and keyboard on `canvas` to the page and returns the hidden text field that holds
 * the keyboard. Moves and wheel turns are sent at most once a frame; a press or key sends any pending move first so
 * the page sees them in order. A finger drags to scroll and taps to click.
 */
function forwardInput(layer: HTMLElement, canvas: HTMLCanvasElement, send: (message: object) => void, copy: () => void) {
  const onMac = mac();
  const keyboard = document.createElement("textarea");
  keyboard.setAttribute("aria-label", "Type into the page");
  keyboard.setAttribute("autocapitalize", "off");
  keyboard.setAttribute("autocomplete", "off");
  keyboard.setAttribute("autocorrect", "off");
  keyboard.spellcheck = false;
  // 16px keeps phones from zooming in on focus.
  keyboard.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;resize:none;font-size:16px;pointer-events:none;caret-color:transparent";
  layer.append(keyboard);
  canvas.style.cursor = "default";
  canvas.style.touchAction = "none";

  const frame = () => {
    const box = canvas.getBoundingClientRect();
    if (!canvas.width || !canvas.height || !box.width || !box.height) return null;
    const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    const width = canvas.width * scale, height = canvas.height * scale;
    // Matches the canvas's object-position: centred across, at the top.
    return { left: box.left + (box.width - width) / 2, top: box.top, width, height };
  };
  /** Where an event lands on the page, as fractions of the frame. Outside the frame it is null, or the nearest edge. */
  const position = (event: MouseEvent, nearest = false) => {
    const area = frame();
    if (!area) return null;
    const x = (event.clientX - area.left) / area.width, y = (event.clientY - area.top) / area.height;
    if (nearest) return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  };
  const pointerModifiers = (event: MouseEvent) => (event.altKey ? ALT : 0) | (event.ctrlKey || (onMac && event.metaKey) ? CTRL : 0) | (!onMac && event.metaKey ? META : 0) | (event.shiftKey ? SHIFT : 0);

  let pendingMove: object | null = null;
  let pendingWheel: { x: number; y: number; deltaX: number; deltaY: number; modifiers: number } | null = null;
  let scheduled = 0;
  const flush = () => {
    cancelAnimationFrame(scheduled); scheduled = 0;
    if (pendingMove) { send(pendingMove); pendingMove = null; }
    if (pendingWheel) {
      const clamp = (value: number) => Math.max(-10_000, Math.min(10_000, value));
      send({ type: "wheel", ...pendingWheel, deltaX: clamp(pendingWheel.deltaX), deltaY: clamp(pendingWheel.deltaY) });
      pendingWheel = null;
    }
  };
  const later = () => { if (!scheduled) scheduled = requestAnimationFrame(flush); };
  const now = (message: object) => { flush(); send(message); };

  // The press in progress, so its release always reaches the page, and the last one, to count double and triple clicks.
  let pressed: { pointerId: number; button: (typeof BUTTONS)[number]; clicks: number; at: { x: number; y: number } } | null = null;
  let last = { time: 0, clientX: 0, clientY: 0, button: -1, clicks: 0 };
  // A finger on the page: where it went down and was last, and whether it moved enough to be a scroll.
  let touch: { pointerId: number; clientX: number; clientY: number; startX: number; startY: number; scrolled: boolean } | null = null;

  const release = (event: PointerEvent) => {
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    const at = position(event, true) ?? pressed.at;
    now({ type: "mouse", event: "up", ...at, button: pressed.button, buttons: event.buttons & 31, clickCount: pressed.clicks, modifiers: pointerModifiers(event) });
    pressed = null;
  };

  canvas.addEventListener("pointerdown", (event) => {
    const at = position(event);
    if (!at) return;
    event.preventDefault();
    keyboard.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    if (event.pointerType === "touch") {
      touch = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, startX: event.clientX, startY: event.clientY, scrolled: false };
      return;
    }
    if (pressed) return;
    const button = BUTTONS[event.button] ?? "left";
    const repeat = event.timeStamp - last.time < MULTI_CLICK_MS && event.button === last.button
      && Math.abs(event.clientX - last.clientX) <= MULTI_CLICK_PX && Math.abs(event.clientY - last.clientY) <= MULTI_CLICK_PX;
    const clicks = repeat ? Math.min(last.clicks + 1, 3) : 1;
    last = { time: event.timeStamp, clientX: event.clientX, clientY: event.clientY, button: event.button, clicks };
    pressed = { pointerId: event.pointerId, button, clicks, at };
    now({ type: "mouse", event: "down", ...at, button, buttons: event.buttons & 31, clickCount: clicks, modifiers: pointerModifiers(event) });
  });
  canvas.addEventListener("pointermove", (event) => {
    if (touch?.pointerId === event.pointerId) {
      const at = position(event, true), area = frame();
      if (!at || !area) return;
      if (Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) > 8) touch.scrolled = true;
      // The page moves with the finger, in the frame's own pixels.
      const scale = canvas.width / area.width;
      const deltaX = (touch.clientX - event.clientX) * scale, deltaY = (touch.clientY - event.clientY) * scale;
      touch.clientX = event.clientX; touch.clientY = event.clientY;
      if (touch.scrolled) {
        pendingWheel = pendingWheel ? { ...pendingWheel, deltaX: pendingWheel.deltaX + deltaX, deltaY: pendingWheel.deltaY + deltaY } : { ...at, deltaX, deltaY, modifiers: 0 };
        later();
      }
      return;
    }
    // While a button is held, a drag past the frame's edge keeps going at the edge, as in a window.
    const at = position(event, pressed !== null);
    if (!at) return;
    if (pressed) pressed.at = at;
    pendingMove = { type: "mouse", event: "move", ...at, button: "none", buttons: event.buttons & 31, clickCount: 0, modifiers: pointerModifiers(event) };
    later();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (touch?.pointerId === event.pointerId) {
      const at = position(event, true);
      if (at && !touch.scrolled) {
        now({ type: "mouse", event: "down", ...at, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
        now({ type: "mouse", event: "up", ...at, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
      }
      flush();
      touch = null;
      return;
    }
    release(event);
  });
  // A press the browser takes away (a system gesture, a lost capture) still ends on the page.
  canvas.addEventListener("pointercancel", (event) => { if (touch?.pointerId === event.pointerId) touch = null; else release(event); });
  canvas.addEventListener("lostpointercapture", release);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("wheel", (event) => {
    const at = position(event);
    if (!at) return;
    event.preventDefault();
    // Lines and pages arrive as counts; the page expects pixels.
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    const deltaX = event.deltaX * unit, deltaY = event.deltaY * unit;
    pendingWheel = pendingWheel ? { ...pendingWheel, ...at, deltaX: pendingWheel.deltaX + deltaX, deltaY: pendingWheel.deltaY + deltaY } : { ...at, deltaX, deltaY, modifiers: pointerModifiers(event) };
    later();
  }, { passive: false });

  const shortcut = (event: KeyboardEvent, letter: string) => (onMac ? event.metaKey : event.ctrlKey) && !event.altKey && event.key.toLowerCase() === letter;
  const key = (kind: "down" | "up") => (event: KeyboardEvent) => {
    // A typing method (or a dead key's accent) is composing; its text arrives when it finishes.
    if (event.isComposing || event.keyCode === 229 || event.key === "Dead") return;
    // Pasting goes through the paste event, which carries the person's clipboard; the computer's doesn't have it.
    if (shortcut(event, "v")) return;
    if (event.key.length > 32 || event.code.length > 32) return;
    event.preventDefault();
    // Copy and cut also bring the selected text to the person's clipboard; the page still gets the key.
    if (kind === "down" && (shortcut(event, "c") || shortcut(event, "x"))) copy();
    const translated = translateKey({ key: event.key, code: event.code, keyCode: event.keyCode, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altGraph: event.getModifierState?.("AltGraph") }, onMac);
    now({ type: "key", event: kind, ...translated, text: kind === "down" ? translated.text : "" });
  };
  keyboard.addEventListener("keydown", key("down"));
  keyboard.addEventListener("keyup", key("up"));
  /** Sends whatever the text field gathered: a finished composition, or input from a keyboard without key events. */
  const typed = () => {
    if (keyboard.value) now({ type: "text", text: keyboard.value.slice(0, 10_000) });
    keyboard.value = "";
  };
  keyboard.addEventListener("compositionend", typed);
  keyboard.addEventListener("input", (event) => {
    const input = event as InputEvent;
    if (input.isComposing) return;
    // Phone keyboards delete without a usable key event.
    if (input.inputType === "deleteContentBackward" && !keyboard.value) {
      for (const kind of ["down", "up"] as const) now({ type: "key", event: kind, key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0, text: "" });
      return;
    }
    typed();
  });
  keyboard.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    event.preventDefault();
    if (text) now({ type: "text", text: text.slice(0, 10_000) });
  });
  return keyboard;
}
