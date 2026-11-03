import type { ReactNode } from "react";

import { CapabilityMatrix } from "./capability-matrix";
import { CompareSection } from "./lp-compare";
import { LpSectionHeader } from "./lp-primitives";

const DEFAULT_CAPTION =
  "Claude Enterprise, Claude Desktop on 3P, and OpenWork compared by capability";

type Props = {
  /** id of the section heading, used for aria-labelledby. */
  id?: string;
  heading?: string;
  /** Heading split over lines, for the landing-page section header. */
  headingLines?: string[];
  caption?: string;
  /**
   * When set, render the landing-page section header (small label above a
   * light heading) instead of the compare-page heading. Used on /enterprise.
   */
  label?: string;
  /** Action on the right of the landing-page section header. */
  right?: ReactNode;
  /** Capability groups to show. Defaults to all of them. */
  groups?: string[];
  /** Anchor for the section itself, for in-page links. */
  anchor?: string;
  className?: string;
};

/**
 * OpenWork vs Claude Cowork capability comparison, shared by the
 * Claude Cowork alternative page and the Enterprise page.
 */
export function CoworkComparison({
  id = "comparison-heading",
  heading = "OpenWork vs Claude Cowork",
  headingLines,
  caption = DEFAULT_CAPTION,
  label,
  right,
  groups,
  anchor,
  className
}: Props) {
  if (!label) {
    return (
      <CompareSection id={id} heading={heading}>
        <CapabilityMatrix caption={caption} groups={groups} />
      </CompareSection>
    );
  }

  return (
    <section id={anchor} aria-labelledby={id} className={`scroll-mt-28 ${className ?? ""}`}>
      <LpSectionHeader id={id} label={label} heading={heading} headingLines={headingLines} right={right} />
      <div className="mt-10">
        <CapabilityMatrix caption={caption} groups={groups} />
      </div>
    </section>
  );
}
