import type { ReactNode } from "react";

export type DenSectionHeaderProps = {
  title: string;
  description?: ReactNode;
  /** Right-aligned slot for the section's primary action. */
  action?: ReactNode;
  /** "center" stacks the header and centers text (used on onboarding). */
  align?: "start" | "center";
  className?: string;
};

export function DenSectionHeader({ title, description, action, align = "start", className = "" }: DenSectionHeaderProps) {
  const layout =
    align === "center"
      ? "flex flex-col items-center gap-2 text-center"
      : "flex flex-wrap items-start justify-between gap-4";
  return (
    <div className={`${layout} ${className}`}>
      <div className="min-w-0">
        <h2 className="text-[16px] font-medium tracking-[-0.02em] text-gray-950">{title}</h2>
        {description ? <p className="mt-1 text-[13px] leading-6 text-gray-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
