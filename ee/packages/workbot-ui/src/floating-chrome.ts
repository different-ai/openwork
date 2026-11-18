import { useLayoutEffect, useState } from "react";

type Frame = { style: Pick<CSSStyleDeclaration, "getPropertyValue" | "setProperty"> };

/** How far the floating header and message box reach over the conversation, for its scroll padding. */
export const CHROME_TOP = "--wb-chrome-top";
export const CHROME_BOTTOM = "--wb-chrome-bottom";

/**
 * The header and the message box float over the conversation (translucent, blurred), so messages scroll underneath
 * them. The conversation pads its first and last message by their measured heights instead, so both can still scroll
 * fully into view. A part that is not floating (another view, a docked chat) reaches over nothing: 0px.
 */
export function observeFloatingChrome(frame: Frame, top: Element | null, bottom: Element | null) {
  const write = (name: string, box: Element | null) => {
    const value = `${box ? Math.ceil(box.getBoundingClientRect().height) : 0}px`;
    // Only on change: a restyle of the frame lays the whole conversation out again.
    if (frame.style.getPropertyValue(name) !== value) frame.style.setProperty(name, value);
  };
  const measure = () => { write(CHROME_TOP, top); write(CHROME_BOTTOM, bottom); };
  measure();
  if (!top && !bottom) return { measure, dispose() {} };
  // Safe areas, the keyboard, a growing message box, a context chip or the status line all change these heights.
  const observer = new ResizeObserver(measure);
  for (const box of [top, bottom]) if (box) observer.observe(box, { box: "border-box" });
  return { measure, dispose() { observer.disconnect(); } };
}

/** Refs for the frame that holds both parts and the conversation, the floating header and the floating message box. */
export function useFloatingChrome() {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState<HTMLElement | null>(null);
  const [bottom, setBottom] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!frame) return;
    return observeFloatingChrome(frame, top, bottom).dispose;
  }, [frame, top, bottom]);
  return { frame: setFrame, top: setTop, bottom: setBottom };
}
