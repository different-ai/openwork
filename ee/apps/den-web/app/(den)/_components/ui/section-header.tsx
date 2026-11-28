import type { ReactNode } from "react";

export type DenSectionHeaderProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  align?: "start" | "center";
  density?: "default" | "compact";
  className?: string;
};

export function DenSectionHeader({ title, description, action, align = "start", density = "default", className = "" }: DenSectionHeaderProps) {
  if (density === "compact") {
    return (
      <div className={`pb-1.5 ${className}`}>
        <div className="flex min-h-5 items-center justify-between gap-4">
          <h2 className="text-[13px] font-semibold leading-5 text-[var(--dls-text-primary)]">{title}</h2>
          {action}
        </div>
        {description ? <p className="text-[12px] leading-4 text-[var(--dls-text-secondary)]">{description}</p> : null}
      </div>
    );
  }

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
