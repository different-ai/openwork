import type { ReactNode } from "react";

type LpSectionHeaderProps = {
  label: string;
  heading: string;
  headingLines?: string[];
  right?: ReactNode;
  size?: "major" | "small";
};

export function LpSectionHeader({
  label,
  heading,
  headingLines,
  right,
  size = "major"
}: LpSectionHeaderProps) {
  const lines = headingLines ?? [heading];

  return (
    <div className="flex flex-col justify-between gap-7 md:flex-row md:items-end">
      <div>
        <div className="mb-3 text-[15px] font-normal text-[var(--lp-muted)]">
          {label}
        </div>
        <h2
          className={`font-light tracking-[-0.015em] text-[var(--lp-ink)] ${
            size === "small"
              ? "text-[36px] leading-[42px]"
              : "text-[36px] leading-[42px] md:text-[44px] md:leading-[50px]"
          }`}
        >
          {lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </h2>
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

type LpAlphaBadgeProps = {
  children?: ReactNode;
};

export function LpAlphaBadge({ children = "Alpha" }: LpAlphaBadgeProps) {
  return (
    <span className="inline-flex items-center rounded-full bg-[#eff6ff] px-[7px] py-0.5 text-[9.5px] font-bold uppercase leading-[14px] tracking-[0.08em] text-[var(--lp-blue)]">
      {children}
    </span>
  );
}

type LpContainerProps = {
  children: ReactNode;
  className?: string;
};

export function LpTonalCard({ children, className }: LpContainerProps) {
  return (
    <div className={`rounded-[24px] bg-[var(--lp-tonal)] ${className ?? ""}`}>
      {children}
    </div>
  );
}

type LpArrowLinkProps = {
  href: string;
  children: ReactNode;
};

export function LpArrowLink({ href, children }: LpArrowLinkProps) {
  return (
    <a
      href={href}
      className="group inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--lp-ink)]"
    >
      <span>{children}</span>
      <span
        aria-hidden="true"
        className="lp-arrow transition-transform duration-150 ease-out group-hover:translate-x-1"
      >
        →
      </span>
    </a>
  );
}
