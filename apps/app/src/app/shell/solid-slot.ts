import { render } from "solid-js/web";
import type { JSX } from "solid-js";
import { createElement, useLayoutEffect, useRef } from "react";

export type SolidSlotProps = {
  slotId: string;
  renderContent: () => JSX.Element;
};

export function SolidSlot(props: SolidSlotProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderRef = useRef(props.renderContent);

  renderRef.current = props.renderContent;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const dispose = render(() => renderRef.current(), container);
    return () => dispose();
  }, []);

  return createElement("div", {
    "data-openwork-react-slot": props.slotId,
    ref: containerRef,
  });
}
