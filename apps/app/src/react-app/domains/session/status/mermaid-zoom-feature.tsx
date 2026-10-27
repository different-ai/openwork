/** @jsxImportSource react */
import type { ReactNode } from "react";

import { MermaidZoomContext } from "@/components/markdown/mermaid-zoom";
import { useDesktopFeature } from "./use-desktop-feature";

/** Resolves the `mermaidZoom` feature once for every rendered Markdown surface. */
export function MermaidZoomFeatureProvider(props: { children: ReactNode }) {
  const enabled = useDesktopFeature("mermaidZoom");
  return <MermaidZoomContext value={enabled}>{props.children}</MermaidZoomContext>;
}
