import type { ElementType, ReactNode } from "react";

export type DenBadgeTone = "neutral" | "info" | "success" | "warning";

const toneClasses: Record<DenBadgeTone, string> = {
  neutral: "bg-gray-100 text-gray-600",
  info: "bg-blue-50 text-blue-700",
  success: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-700",
};

export type DenBadgeProps = {
  children: ReactNode;
  tone?: DenBadgeTone;
  icon?: ElementType;
  className?: string;
};

export function DenBadge({ children, tone = "neutral", icon: Icon, className = "" }: DenBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${toneClasses[tone]} ${className}`}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {children}
    </span>
  );
}
