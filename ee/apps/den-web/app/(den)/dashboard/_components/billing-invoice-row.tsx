import { ExternalLink } from "lucide-react";
import type { BillingInvoiceStatus } from "@openwork/types/den/billing-invoices";
import { DenBadge, type DenBadgeTone } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenSkeleton } from "../../_components/ui/skeleton";

/** Normal states stay neutral; colour marks what needs attention (DESIGN.md V2, C5). */
const STATUS_BADGES: Record<BillingInvoiceStatus, { label: string; tone: DenBadgeTone }> = {
  paid: { label: "Paid", tone: "neutral" },
  void: { label: "Void", tone: "neutral" },
  open: { label: "Due", tone: "warning" },
  uncollectible: { label: "Unpaid", tone: "danger" },
};

export type BillingInvoiceRowProps = {
  date: string;
  number: string | null;
  amount: string;
  status: BillingInvoiceStatus;
  /** Stripe's hosted invoice page (view, pay, download). Omitted in the intro example. */
  href?: string | null;
  /** The intro example's gentle highlight. */
  active?: boolean;
  /** `example` drops the list's 24px inset to sit inside the intro example's frame. */
  inset?: "list" | "example";
};

/**
 * One invoice: date and number left, amount and status right, one action (S2).
 * Stripe's page holds the PDF and receipt downloads, so a single link covers them.
 */
export function BillingInvoiceRow({ date, number, amount, status, href, active = false, inset = "list" }: BillingInvoiceRowProps) {
  const badge = STATUS_BADGES[status];
  const actionLabel = status === "open" ? "Pay" : "View";
  return (
    <li
      className={`flex min-h-12 items-center gap-4 py-2.5 transition-colors duration-150 ease-out ${inset === "list" ? "px-6" : "-mx-2 rounded-lg px-2"} ${active ? "bg-gray-50" : ""}`}
      data-testid="billing-invoice-row"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-gray-950">{date}</p>
        {number ? <p className="truncate font-mono text-[12px] text-gray-500">{number}</p> : null}
      </div>
      <span className="shrink-0 text-[14px] font-medium tabular-nums text-gray-950">{amount}</span>
      <span className="flex w-[64px] shrink-0 justify-end">
        <DenBadge size="sm" tone={badge.tone}>{badge.label}</DenBadge>
      </span>
      {href !== undefined ? (
        <span className="flex w-[76px] shrink-0 justify-end">
          {href ? (
            <DenButton
              variant={status === "open" ? "secondary" : "ghost"}
              size="xs"
              icon={ExternalLink}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${actionLabel} invoice ${number ?? date} in Stripe`}
            >
              {actionLabel}
            </DenButton>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/** Loading keeps the list's layout (DESIGN.md States). */
export function BillingInvoiceRowSkeleton() {
  return (
    <li className="flex min-h-12 items-center gap-4 px-6 py-2.5" aria-hidden="true">
      <div className="flex-1 space-y-1.5">
        <DenSkeleton className="h-3.5 w-24" />
        <DenSkeleton className="h-3 w-32" />
      </div>
      <DenSkeleton className="h-3.5 w-16" />
      <span className="flex w-[64px] justify-end"><DenSkeleton className="h-5 w-12 rounded-full" /></span>
      <span className="flex w-[76px] justify-end"><DenSkeleton className="h-6 w-14" /></span>
    </li>
  );
}
