"use client";

import type { ElementType, ReactNode } from "react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { orgFeatureEnabled } from "../../_lib/den-org";
import { useWebGlSupported } from "../../_lib/use-webgl-supported";
import { useOrgDashboard } from "../../dashboard/_providers/org-dashboard-provider";
import { DenPageHeader } from "./page-header";

/**
 * Shared shell for org dashboard pages, all beneath OrgDashboardProvider.
 * denFlatPageHeaders changes only the heading; switching it off restores the
 * legacy banner without changing navigation, page content, or stored data.
 */

export type DashboardPageTemplateProps = {
  /** Retained for compatibility; the shared Trim header does not render an icon. */
  icon?: ElementType<{
    size?: number;
    className?: string;
    strokeWidth?: number;
  }>;
  /** Semantic page heading; compact when denFlatPageHeaders is enabled. */
  title: string;
  /** Supporting context retained above the page content. */
  description: ReactNode;
  /** Legacy banner colors, accepted but unused by the flat header. */
  colors: [string, string, string, string];
  /** Retained for compatibility; all pages use the shared Trim header size. */
  size?: "default" | "compact" | "responsive";
  /** Retained for compatibility; supporting copy always renders below the header. */
  descriptionPlacement?: "below" | "hero";
  children?: React.ReactNode;
};

// Mount the WebGL detection hook only for the legacy header. The flat branch
// renders neither a canvas nor a CSS gradient, including on WebGL-less clients.
function LegacyDashboardHeader({ title, colors }: Pick<DashboardPageTemplateProps, "title" | "colors">) {
  const webGlSupported = useWebGlSupported();

  return (
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
      </div>
    </div>
  );
}

export function DashboardPageTemplate({
  title,
  description,
  colors,
  children,
}: DashboardPageTemplateProps) {
  const { orgContext } = useOrgDashboard();
  const flatHeader = orgFeatureEnabled(orgContext, "denFlatPageHeaders");

  return (
    <div className="mx-auto max-w-[860px] p-4 sm:p-6 md:p-8">
      {flatHeader ? (
        <div data-dashboard-flat-header>
          <DenPageHeader title={title} size="compact" className="mb-1 break-words" />
        </div>
      ) : (
        <LegacyDashboardHeader title={title} colors={colors} />
      )}

      {/* Supporting context and children are identical on both sides of the gate. */}
      <p className="mb-6 text-[14px] text-gray-500">{description}</p>

      {/* ── Page content ── */}
      {children}
    </div>
  );
}
