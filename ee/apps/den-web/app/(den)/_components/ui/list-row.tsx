import Link from "next/link";
import type { ReactNode } from "react";

export type DenListRowTone = "default" | "warning";

export type DenListRowProps = {
  leading?: ReactNode;
  title: ReactNode;
  chips?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  href?: string;
  tone?: DenListRowTone;
  /** Temporary emphasis, e.g. a row targeted by a deep link. */
  focused?: boolean;
  dataAttributes?: Record<string, string | undefined>;
};

export type DenListProps = {
  children: ReactNode;
  className?: string;
};

export function DenList({ children, className = "" }: DenListProps) {
  return (
    <div className={`divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white ${className}`}>
      {children}
    </div>
  );
}

export function DenListRow({
  leading,
  title,
  chips,
  meta,
  action,
  href,
  tone = "default",
  focused = false,
  dataAttributes,
}: DenListRowProps) {
  const className = `flex items-center gap-3 px-6 py-4 transition ${tone === "warning" ? "bg-amber-50/40" : ""} ${href ? "hover:bg-gray-50" : ""} ${focused ? "bg-blue-50/70 ring-2 ring-inset ring-blue-200" : ""}`;
  const content = (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="truncate text-[14px] font-semibold text-gray-900">{title}</div>
          {chips}
        </div>
        {meta ? <div className="truncate text-[12px] text-gray-500">{meta}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </>
  );

  if (href) {
    return (
      <Link {...dataAttributes} href={href} className={className}>
        {content}
      </Link>
    );
  }

  return (
    <div {...dataAttributes} className={className}>
      {content}
    </div>
  );
}
