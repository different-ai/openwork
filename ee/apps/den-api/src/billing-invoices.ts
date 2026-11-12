import {
  BILLING_INVOICE_STATUSES,
  type BillingInvoice,
  type BillingInvoiceStatus,
  type BillingInvoicesResponse,
} from "@openwork/types/den/billing-invoices"

/** The Stripe invoice fields Billing shows; a subset of `Stripe.Invoice`. */
export type StripeInvoiceFields = {
  id?: string | null
  number: string | null
  status: string | null
  created: number
  total: number
  amount_due: number
  amount_paid: number
  currency: string
  period_start: number
  period_end: number
  hosted_invoice_url?: string | null
  invoice_pdf?: string | null
}

export type OrganizationInvoicePage = BillingInvoicesResponse

function isListedStatus(status: string | null): status is BillingInvoiceStatus {
  return BILLING_INVOICE_STATUSES.some((value) => value === status)
}

function isoFromUnixSeconds(value: number | null | undefined): string | null {
  return typeof value === "number" && value > 0 ? new Date(value * 1000).toISOString() : null
}

/** Stripe's own links only: anything else is dropped rather than linked to. */
function stripeUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const host = url.hostname
    return url.protocol === "https:" && (host === "stripe.com" || host.endsWith(".stripe.com")) ? url.toString() : null
  } catch {
    return null
  }
}

export function serializeInvoice(invoice: StripeInvoiceFields): BillingInvoice | null {
  if (!invoice.id || !isListedStatus(invoice.status)) return null
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    createdAt: isoFromUnixSeconds(invoice.created) ?? new Date(0).toISOString(),
    total: invoice.total,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
    periodStart: isoFromUnixSeconds(invoice.period_start),
    periodEnd: isoFromUnixSeconds(invoice.period_end),
    hostedInvoiceUrl: stripeUrl(invoice.hosted_invoice_url),
    invoicePdfUrl: stripeUrl(invoice.invoice_pdf),
  }
}

/**
 * Drafts are dropped, but the cursor is the last invoice Stripe returned, so
 * the next page continues after it even when it was a draft.
 */
export function serializeInvoicePage(invoices: readonly StripeInvoiceFields[], hasMore: boolean): OrganizationInvoicePage {
  const last = invoices.at(-1)
  return {
    invoices: invoices.flatMap((invoice) => {
      const serialized = serializeInvoice(invoice)
      return serialized ? [serialized] : []
    }),
    hasMore,
    nextCursor: hasMore && last?.id ? last.id : null,
  }
}
