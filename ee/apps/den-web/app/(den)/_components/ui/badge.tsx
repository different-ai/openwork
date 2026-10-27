import type { ElementType, ReactNode } from "react";

export type DenBadgeTone = "neutral" | "info" | "success" | "warning" | "danger";
export type DenBadgeSize = "md" | "sm";

const toneClasses: Record<DenBadgeTone, string> = {
  neutral: "bg-gray-100 text-gray-600",
  info: "bg-blue-50 text-blue-700",
  success: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-600",
};

const sizeClasses: Record<DenBadgeSize, string> = {
  md: "gap-1.5 px-2.5 py-1 text-[12px]",
  // The compact pill beside a name or label, e.g. Admin / Invited in Members.
  sm: "gap-1 px-2 py-0.5 text-[11px]",
};

export type DenBadgeProps = {
  children: ReactNode;
  tone?: DenBadgeTone;
  size?: DenBadgeSize;
  icon?: ElementType;
  className?: string;
};

export function DenBadge({ children, tone = "neutral", size = "md", icon: Icon, className = "" }: DenBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${sizeClasses[size]} ${toneClasses[tone]} ${className}`}
    >
      {Icon ? <Icon className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden /> : null}
      {children}
    </span>
  );
}
