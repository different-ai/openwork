"use client";

import { GrainGradient } from "@paper-design/shaders-react";
import { useEffect, useRef, useState } from "react";

export function ResponsiveGrain(props) {
  const containerRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        });
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={`grain-container ${props.className || ""}`}
    >
      {dimensions.width > 0 && dimensions.height > 0 ? (
        <GrainGradient
          width={dimensions.width}
          height={dimensions.height}
          colors={props.colors}
          colorBack={props.colorBack}
          softness={props.softness}
          intensity={props.intensity}
          noise={props.noise}
          shape={props.shape}
          speed={props.speed}
        />
      ) : null}
    </div>
  );
}
