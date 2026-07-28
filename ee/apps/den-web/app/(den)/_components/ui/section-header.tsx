import type { ReactNode } from "react";

export type DenSectionHeaderProps = {
  title: string;
  description?: ReactNode;
  /** Right-aligned slot for the section's primary action. */
  action?: ReactNode;
  className?: string;
};

export function DenSectionHeader({ title, description, action, className = "" }: DenSectionHeaderProps) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-[16px] font-medium tracking-[-0.02em] text-gray-950">{title}</h2>
        {description ? <p className="mt-1 text-[13px] leading-6 text-gray-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
