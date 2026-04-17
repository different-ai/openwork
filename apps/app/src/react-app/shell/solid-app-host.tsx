/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import type { JSX as SolidJSX } from "solid-js";
import { render } from "solid-js/web";

import SolidApp from "../../app/app";

type SolidAppHostProps = {
  className?: string;
};

export function SolidAppHost(props: SolidAppHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const dispose = render(
      () => (SolidApp as unknown as () => SolidJSX.Element)(),
      container,
    );
    return () => {
      dispose();
      container.innerHTML = "";
    };
  }, []);

  return <div ref={containerRef} className={props.className} style={{ height: "100%" }} />;
}
