import { Loader2 } from "lucide-react";
import type { ElementType, HTMLAttributes, ReactNode } from "react";

export type DenChipTone = "neutral" | "info" | "success" | "warning" | "danger" | "violet" | "teal";
export type DenChipSize = "xs" | "sm";

export type DenChipProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  children: ReactNode;
  tone?: DenChipTone;
  size?: DenChipSize;
  icon?: ElementType;
  spinning?: boolean;
  mono?: boolean;
  className?: string;
};

const toneClasses: Record<DenChipTone, string> = {
  neutral: "bg-gray-100 text-gray-500",
  info: "bg-blue-50 text-blue-700",
  success: "bg-emerald-50 text-emerald-700",
  warning: "bg-amber-50 text-amber-700",
  danger: "bg-red-50 text-red-700",
  violet: "bg-violet-50 text-violet-700",
  teal: "bg-teal-50 text-teal-700",
};

const sizeClasses: Record<DenChipSize, string> = {
  xs: "inline-flex h-[19px] items-center gap-1 rounded-full px-2 text-[11px] font-medium",
  sm: "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium",
};

export function DenChip({
  children,
  tone = "neutral",
  size = "xs",
  icon: Icon,
  spinning = false,
  mono = false,
  className = "",
  ...rest
}: DenChipProps) {
  return (
    <span
      {...rest}
      className={`${sizeClasses[size]} ${toneClasses[tone]} ${mono ? "font-mono" : ""} ${className}`}
    >
      {spinning ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : Icon ? (
        <Icon className="h-3 w-3" aria-hidden />
      ) : null}
      {children}
    </span>
  );
}
