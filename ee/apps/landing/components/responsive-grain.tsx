"use client";

import { PaperGrainGradient } from "@openwork/ui/react";

type Props = {
  seed?: string;
  colors: string[];
  colorBack: string;
  softness: number;
  intensity: number;
  noise: number;
  shape: "corners" | "wave" | "dots" | "truchet" | "ripple" | "blob" | "sphere";
  speed: number;
  className?: string;
};

export function ResponsiveGrain(props: Props) {
  return (
    <PaperGrainGradient
      className={`absolute inset-0 overflow-hidden ${props.className || ""}`}
      seed={props.seed}
      colors={props.colors}
      colorBack={props.colorBack}
      softness={props.softness}
      intensity={props.intensity}
      noise={props.noise}
      shape={props.shape}
      speed={props.speed}
    />
  );
}
