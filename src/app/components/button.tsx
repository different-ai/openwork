import { splitProps } from "solid-js";
import type { JSX } from "solid-js";

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "outline" | "danger";
};

export default function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "class", "disabled", "title", "type"]);
  const variant = () => local.variant ?? "primary";

  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 active:scale-95 focus:outline-none focus:ring-2 focus:ring-gray-6/15 disabled:opacity-50 disabled:cursor-not-allowed";

  const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
    primary: "bg-gray-12 text-gray-1 hover:bg-gray-11 shadow-lg shadow-gray-12/5",
    secondary: "bg-gray-4 text-gray-12 hover:bg-gray-5 border border-gray-7/50",
    ghost: "bg-transparent text-gray-11 hover:text-gray-12 hover:bg-gray-4/50",
    outline: "border border-gray-7 text-gray-11 hover:border-gray-7 bg-transparent",
    danger: "bg-red-7/10 text-red-11 hover:bg-red-7/20 border border-red-7/20",
  };

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      disabled={local.disabled}
      aria-disabled={local.disabled}
      title={local.title}
      class={`${base} ${variants[variant()]} ${local.class ?? ""}`.trim()}
    />
  );
}
