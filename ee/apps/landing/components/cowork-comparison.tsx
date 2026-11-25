import type { ReactNode } from "react";

import { CapabilityMatrix } from "./capability-matrix";
import { CompareSection } from "./lp-compare";
import { LpSectionHeader } from "./lp-primitives";

const DEFAULT_CAPTION =
  "Claude Enterprise, Claude Desktop on 3P, and OpenWork compared by capability";

type Props = {
  id?: string;
  heading?: string;
  headingLines?: string[];
  caption?: string;
  label?: string;
  right?: ReactNode;
  groups?: string[];
  anchor?: string;
  className?: string;
};

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
