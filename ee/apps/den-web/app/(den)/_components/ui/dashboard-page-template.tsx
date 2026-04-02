"use client";

import type { ElementType } from "react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { Dithering } from "@paper-design/shaders-react";

/**
 * DashboardPageTemplate
 *
 * A consistent page shell for all org dashboard pages.
 * Provides:
 *  - A gradient hero card (icon + badge + title)
 *  - A description line below the card
 *  - A children slot for page-specific content
 *
 * Caller controls only the gradient `colors` tuple — everything else
 * (distortion, swirl, grain, speed, frame, dithering overlay) is fixed
 * so every page looks coherent.
 */

export type DashboardPageTemplateProps = {
  /** Lucide (or any) icon component rendered inside the frosted glass icon box */
  icon: ElementType<{
    size?: number;
    className?: string;
    strokeWidth?: number;
  }>;
  /** Short label rendered as a frosted pill badge above the title. Omit to hide. */
  badgeLabel?: string;
  /** Page heading rendered large inside the card */
  title: string;
  /** One-liner rendered in gray below the card, above children */
  description: string;
  /**
   * Exactly 4 CSS hex colors for the mesh gradient.
   * Tip: vary hue across pages so each section feels distinct at a glance.
   */
  colors: [string, string, string, string];
  children?: React.ReactNode;
};

export function DashboardPageTemplate({
  icon: Icon,
  badgeLabel,
  title,
  description,
  colors,
  children,
}: DashboardPageTemplateProps) {
  return (
    <div className="mx-auto max-w-[860px] p-8">
      {/* ── Gradient hero card ── */}
      <div className="relative mb-8 flex h-[200px] items-center overflow-hidden rounded-3xl border border-gray-100 px-10">
        {/* Background layers: mesh gradient wrapped in a dithering texture */}
        <div className="absolute inset-0 z-0">
          <Dithering
            speed={0}
            shape="warp"
            type="4x4"
            size={2.5}
            scale={1}
            frame={41112.4}
            colorBack="#00000000"
            colorFront="#FEFEFE"
            style={{
              backgroundColor: "#0f172a",
              width: "100%",
              height: "100%",
            }}
          >
            <PaperMeshGradient
              speed={0.1}
              distortion={0.8}
              swirl={0.1}
              grainMixer={0}
              grainOverlay={0}
              frame={176868.9}
              colors={colors}
              style={{ width: "100%", height: "100%" }}
            />
          </Dithering>
        </div>

        {/* Icon — top right */}
        <div className="absolute right-8 top-8 z-10 flex h-12 w-12 items-center justify-center rounded-xl border border-white/30 bg-white/20 backdrop-blur-md">
          <Icon size={24} className="text-white" strokeWidth={1.5} />
        </div>

        {/* Badge (optional) + Title — bottom left */}
        <div className="absolute bottom-8 left-10 z-10 flex flex-col items-start gap-2">
          {badgeLabel ? (
            <span className="rounded-full border border-white/20 bg-white/20 px-2.5 py-1 text-[10px] uppercase tracking-[1px] text-white backdrop-blur-md">
              {badgeLabel}
            </span>
          ) : null}
          <h1 className="text-[28px] font-medium tracking-[-0.5px] text-white">
            {title}
          </h1>
        </div>
      </div>

      {/* ── Description ── */}
      <p className="mb-6 text-[14px] text-gray-500">{description}</p>

      {/* ── Page content ── */}
      {children}
    </div>
  );
}
