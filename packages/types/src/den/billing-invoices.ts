import { z } from "zod";

/** Largest page `GET /v1/billing/stripe/invoices` returns. */
export const BILLING_INVOICES_MAX_PAGE_SIZE = 50;
export const BILLING_INVOICES_DEFAULT_PAGE_SIZE = 24;

export const billingInvoicesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BILLING_INVOICES_MAX_PAGE_SIZE).optional(),
  /** `nextCursor` from the previous page. */
  cursor: z.string().trim().min(1).max(255).optional(),
});
export type BillingInvoicesQuery = z.infer<typeof billingInvoicesQuerySchema>;

/** Stripe invoice statuses shown to people; drafts are never listed. */
export const BILLING_INVOICE_STATUSES = ["open", "paid", "uncollectible", "void"] as const;
export type BillingInvoiceStatus = (typeof BILLING_INVOICE_STATUSES)[number];

export const billingInvoiceSchema = z.object({
  id: z.string(),
  /** Stripe's invoice number, such as `A1B2C3D4-0001`. */
  number: z.string().nullable(),
  status: z.enum(BILLING_INVOICE_STATUSES),
  /** ISO date the invoice was created. */
  createdAt: z.string(),
  /** Smallest currency unit, like Stripe. */
  total: z.number().int(),
  amountDue: z.number().int(),
  amountPaid: z.number().int(),
  currency: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  /** Stripe's page to view, and for open invoices pay, the invoice. */
  hostedInvoiceUrl: z.string().nullable(),
  invoicePdfUrl: z.string().nullable(),
});
export type BillingInvoice = z.infer<typeof billingInvoiceSchema>;

export const billingInvoicesResponseSchema = z.object({
  invoices: z.array(billingInvoiceSchema),
  hasMore: z.boolean(),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type BillingInvoicesResponse = z.infer<typeof billingInvoicesResponseSchema>;
