"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/** Page column shared by every Library and Manage screen. */
export function ItemPage({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="mx-auto flex w-full max-w-[896px] flex-col gap-7 px-6 py-10 md:px-12" data-testid={testId}>
      {children}
    </div>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex w-fit items-center gap-1.5 text-[13px] text-gray-500 transition-colors hover:text-gray-900">
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      {label}
    </Link>
  );
}

/**
 * Title block for an item or a step: optional logo, title and one line of
 * description, with the page's actions on the right.
 */
export function ItemHeader({ back, logo, title, description, actions }: {
  back?: { href: string; label: string };
  logo?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      {back ? <BackLink href={back.href} label={back.label} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {logo}
          <div className="min-w-0">
            <h1 className="truncate text-[28px] font-medium leading-[34px] tracking-[-0.5px] text-gray-950">{title}</h1>
            {description ? <p className="mt-0.5 text-[14px] leading-5 text-gray-500">{description}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Section title with an optional count or hint on the right. */
export function SectionTitle({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2 className="text-[15px] font-semibold leading-5 text-gray-900">{title}</h2>
      {meta ? <span className="text-[12px] leading-4 text-gray-500">{meta}</span> : null}
    </div>
  );
}

/** Footer under a step: a short consequence on the left, actions on the right. */
export function StepFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p className="text-[12px] leading-4 text-gray-500" data-testid="step-footer-note">{note}</p>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
