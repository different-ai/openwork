import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "ghost" | "secondary";

const base =
  "inline-flex items-center gap-[0.6rem] font-sans font-medium leading-none whitespace-nowrap rounded-md transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed";

const sizes = {
  md: "h-[4rem] px-[1.6rem] text-[1.4rem]",
  lg: "h-[4.8rem] px-[2rem] text-[1.5rem]"
} as const;

const variants: Record<Variant, string> = {
  primary:
    "bg-foreground text-background hover:bg-primary hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]",
  ghost:
    "bg-transparent text-foreground/80 hover:text-foreground border border-border-soft hover:bg-background-muted",
  secondary:
    "bg-background-muted text-foreground hover:bg-background-strong border border-border-soft"
};

type CommonProps = {
  variant?: Variant;
  size?: keyof typeof sizes;
  children: ReactNode;
  className?: string;
};

type LinkProps = CommonProps & {
  href: string;
  external?: boolean;
};

type ButtonProps = CommonProps & ComponentProps<"button"> & { href?: never };

export function LinButton({
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: LinkProps | ButtonProps) {
  const cls = cn(base, sizes[size], variants[variant], className);

  if ("href" in rest && rest.href) {
    const { href, external, ...linkRest } = rest;
    if (external || href.startsWith("http")) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cls} {...linkRest}>
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }

  const { href: _ignored, external: _e, ...buttonRest } = rest as ButtonProps;
  return (
    <button className={cls} {...buttonRest}>
      {children}
    </button>
  );
}

export default LinButton;
