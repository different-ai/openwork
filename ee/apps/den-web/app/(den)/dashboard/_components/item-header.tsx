"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DASHBOARD_PAGE_CLASS, SETTINGS_MEASURE_CLASS } from "../../_components/ui/dashboard-styles";

/** Page column shared by every Library and Manage screen. */
export function ItemPage({ children, testId, wide = false }: { children: ReactNode; testId?: string; /** A list: takes the whole page column. */ wide?: boolean }) {
  return (
    <div className={DASHBOARD_PAGE_CLASS} data-testid={testId}>
      {/* A list takes the page; an item, a form or a step keeps the settings measure, so a label and its value stay within reach. */}
      <div className={`flex flex-col gap-6 ${wide ? "" : SETTINGS_MEASURE_CLASS}`}>{children}</div>
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
export function ItemHeader({ back, logo, title, description, state, actions, compact = false }: {
  back?: { href: string; label: string };
  logo?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** One muted line of state under the title ("4 members"), with `compact`. */
  state?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="flex flex-col gap-4" data-library-integrated-header>
        {back ? <BackLink href={back.href} label={back.label} /> : null}
        <DenPageHeader size="compact" state={state} title={<span className="flex min-w-0 items-center gap-3">{logo}<span className="min-w-0 break-words">{title}</span></span>} action={actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : undefined} />
        {description ? <p className="text-[13px] text-[var(--dls-text-secondary)]">{description}</p> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {back ? <BackLink href={back.href} label={back.label} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {logo}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-[var(--dls-text-primary)]">{title}</h1>
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
      <h2 className="text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">{title}</h2>
      {meta ? <span className="text-[12px] leading-4 text-[var(--dls-text-secondary)]">{meta}</span> : null}
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
