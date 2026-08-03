"use client";

import type { ElementType, ReactNode } from "react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { useWebGlSupported } from "../../_lib/use-webgl-supported";

/**
 * DashboardPageTemplate
 *
 * A consistent page shell for all org dashboard pages.
 * Provides:
 *  - A compact gradient hero card (badge + title)
 *  - A description line below the card
 *  - A children slot for page-specific content
 *
 * Caller controls only the gradient `colors` tuple — everything else
 * (distortion, swirl, grain, speed, frame) is fixed
 * so every page looks coherent.
 */

export type DashboardPageTemplateProps = {
  /** Retained for compatibility; the shared Trim header does not render an icon. */
  icon?: ElementType<{
    size?: number;
    className?: string;
    strokeWidth?: number;
  }>;
  /** Short label rendered as a frosted pill badge beside the title. Omit to hide. */
  badgeLabel?: string;
  /** Optional content rendered beside the badge inside the gradient band. */
  badgeCompanion?: ReactNode;
  /** Page heading rendered large inside the card */
  title: string;
  /** One-liner rendered in gray below the card, above children */
  description: ReactNode;
  /**
   * Exactly 4 CSS hex colors for the mesh gradient.
   * Tip: vary hue across pages so each section feels distinct at a glance.
   */
  colors: [string, string, string, string];
  /** Retained for compatibility; all pages use the shared Trim header size. */
  size?: "default" | "compact" | "responsive";
  /** Retained for compatibility; supporting copy always renders below the header. */
  descriptionPlacement?: "below" | "hero";
  children?: React.ReactNode;
};

export function DashboardPageTemplate({
  badgeLabel,
  badgeCompanion,
  title,
  description,
  colors,
  children,
}: DashboardPageTemplateProps) {
  const webGlSupported = useWebGlSupported();

  return (
    <div className="mx-auto max-w-[860px] p-4 sm:p-6 md:p-8">
      {/* ── Gradient hero card ── */}
      <div
        data-dashboard-hero
        className="relative mb-4 flex h-[104px] items-center overflow-hidden rounded-lg border border-gray-100 px-6"
      >
        <div className="absolute -top-[90px] inset-x-0 z-0 h-[280px]">
          {webGlSupported ? (
            <PaperMeshGradient
              speed={0.08}
              scale={1}
              distortion={0.8}
              swirl={0.1}
              grainMixer={0}
              grainOverlay={0}
              frame={176868.9}
              colors={colors}
              style={{ width: "100%", height: "100%" }}
            />
          ) : (
            <div className="h-full w-full" style={{ background: `linear-gradient(135deg, ${colors.join(", ")})` }} />
          )}
        </div>
        <div
          className="absolute inset-0 z-[1]"
          style={{ background: "linear-gradient(90deg, rgba(11,20,32,.52) 0%, rgba(11,20,32,.18) 55%, rgba(11,20,32,.04) 100%)" }}
        />

        <div className="relative z-10 flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-white">{title}</h1>
          {badgeLabel ? (
            <span className="shrink-0 rounded-full border border-white/20 bg-white/20 px-2.5 py-1 text-[10px] uppercase tracking-[1px] text-white backdrop-blur-md">
              {badgeLabel}
            </span>
          ) : null}
          {badgeCompanion}
        </div>
      </div>

      {/* ── Description ── */}
      <p className="mb-6 text-[14px] text-gray-500">{description}</p>

      {/* ── Page content ── */}
      {children}
    </div>
  );
}
