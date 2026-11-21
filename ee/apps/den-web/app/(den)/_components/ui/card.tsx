"use client";

import { forwardRef, type HTMLAttributes } from "react";

export type DenCardSize = "comfortable" | "spacious";

const sizeClasses: Record<DenCardSize, string> = {
  comfortable: "rounded-2xl p-4",
  spacious: "rounded-2xl p-6",
};

export type DenCardProps = HTMLAttributes<HTMLDivElement> & {
  size?: DenCardSize;
};

export const DenCard = forwardRef<HTMLDivElement, DenCardProps>(function DenCard(
  { size = "comfortable", className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...rest}
      className={[
        "border border-[var(--den-shell-line)] bg-[var(--den-shell-topbar)]",
        sizeClasses[size],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
});
