import { createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { JSX } from "solid-js";
import { createElement, useLayoutEffect, useRef } from "react";

export type SolidSlotProps = {
  slotId: string;
  renderContent: () => JSX.Element;
};

export function SolidSlot(props: SolidSlotProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setContentRef = useRef<((next: () => JSX.Element) => void) | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const dispose = createRoot((disposeRoot) => {
      const [content, setContent] = createSignal(props.renderContent);
      setContentRef.current = (next) => {
        setContent(() => next);
      };
      const disposeRender = render(() => content()(), container);
      return () => {
        setContentRef.current = null;
        disposeRender();
        disposeRoot();
      };
    });
    return () => dispose();
  }, []);

  useLayoutEffect(() => {
    setContentRef.current?.(props.renderContent);
  }, [props.slotId, props.renderContent]);

  return createElement("div", {
    "data-openwork-react-slot": props.slotId,
    ref: containerRef,
  });
}
