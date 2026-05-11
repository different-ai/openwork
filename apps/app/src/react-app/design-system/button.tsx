/** @jsxImportSource react */
import type { ComponentProps } from "react";

export type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "outline" | "danger";
};

const base =
  "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-all duration-150 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] disabled:opacity-50 disabled:cursor-not-allowed";

const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    "bg-[#011627] text-white hover:bg-black border border-transparent",
  secondary:
    "bg-[#011627] text-white hover:bg-black border border-transparent",
  ghost:
    "bg-transparent text-dls-secondary hover:text-dls-text hover:bg-dls-hover",
  outline:
    "border border-dls-border text-dls-text hover:bg-dls-hover bg-transparent",
  danger: "bg-red-3 text-red-11 hover:bg-red-4 border border-red-6",
};

export function Button({ variant, className, type, disabled, ref, ...rest }: ButtonProps) {
  const effectiveVariant = variant ?? "primary";
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled}
      aria-disabled={disabled}
      className={`${base} ${variants[effectiveVariant]} ${className ?? ""}`.trim()}
      {...rest}
    />
  );
}
