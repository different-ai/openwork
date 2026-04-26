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
    <div className="mx-auto max-w-[900px] p-6 md:p-8">
      {/* ── Gradient hero card ── */}
      <div className="relative mb-6 flex h-[176px] items-center overflow-hidden rounded-2xl border border-[#e5edf5] bg-white px-8 shadow-[0_24px_42px_-34px_rgba(50,50,93,0.28)]">
        {/* Background layers: mesh gradient wrapped in a dithering texture */}
        <div className="absolute inset-y-0 right-0 z-0 w-[42%] opacity-95">
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
              backgroundColor: "#061b31",
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

        <div className="absolute inset-y-0 right-[34%] z-0 w-36 bg-[linear-gradient(90deg,#fff,rgba(255,255,255,0.7),rgba(255,255,255,0))]" />

        {/* Icon + title */}
        <div className="relative z-10 flex max-w-[28rem] flex-col items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#d6d9fc] bg-[#f6f4ff] text-[#533afd]">
            <Icon size={22} strokeWidth={1.7} />
          </div>
          {badgeLabel ? (
            <span className="rounded-md border border-[#e5edf5] bg-[#f6f9fc] px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-[#64748d]">
              {badgeLabel}
            </span>
          ) : null}
          <h1 className="text-[28px] font-semibold tracking-normal text-[#061b31]">
            {title}
          </h1>
        </div>
      </div>

      {/* ── Description ── */}
      <p className="mb-6 max-w-[44rem] text-[14px] leading-6 text-[#64748d]">{description}</p>

      {/* ── Page content ── */}
      {children}
    </div>
  );
}
