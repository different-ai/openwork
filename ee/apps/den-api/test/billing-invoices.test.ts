import assert from "node:assert/strict"
import { test } from "node:test"
import { billingInvoicesQuerySchema } from "@openwork/types/den/billing-invoices"
import { serializeInvoice, serializeInvoicePage, type StripeInvoiceFields } from "../src/billing-invoices.js"

function invoice(overrides: Partial<StripeInvoiceFields> = {}): StripeInvoiceFields {
  return {
    id: "in_1",
    number: "ABCD-0001",
    status: "paid",
    created: 1_762_000_000,
    total: 12_000,
    amount_due: 12_000,
    amount_paid: 12_000,
    currency: "usd",
    period_start: 1_759_000_000,
    period_end: 1_761_600_000,
    hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/test_abc",
    invoice_pdf: "https://pay.stripe.com/invoice/acct_1/test_abc/pdf",
    ...overrides,
  }
}

test("an invoice keeps its amounts, dates and Stripe links", () => {
  assert.deepEqual(serializeInvoice(invoice()), {
    id: "in_1",
    number: "ABCD-0001",
    status: "paid",
    createdAt: new Date(1_762_000_000_000).toISOString(),
    total: 12_000,
    amountDue: 12_000,
    amountPaid: 12_000,
    currency: "usd",
    periodStart: new Date(1_759_000_000_000).toISOString(),
    periodEnd: new Date(1_761_600_000_000).toISOString(),
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/test_abc",
    invoicePdfUrl: "https://pay.stripe.com/invoice/acct_1/test_abc/pdf",
  })
})

test("drafts and unknown statuses are never listed", () => {
  assert.equal(serializeInvoice(invoice({ status: "draft" })), null)
  assert.equal(serializeInvoice(invoice({ status: null })), null)
  assert.equal(serializeInvoice(invoice({ id: null })), null)
})

test("only https links on stripe.com are returned", () => {
  const serialized = serializeInvoice(invoice({
    hosted_invoice_url: "https://stripe.com.evil.example/i/1",
    invoice_pdf: "http://pay.stripe.com/invoice/1/pdf",
  }))
  assert.equal(serialized?.hostedInvoiceUrl, null)
  assert.equal(serialized?.invoicePdfUrl, null)
})

test("the next cursor is the last invoice Stripe returned, even a skipped draft", () => {
  const page = serializeInvoicePage([invoice({ id: "in_1" }), invoice({ id: "in_2", status: "draft" })], true)
  assert.deepEqual(page.invoices.map((row) => row.id), ["in_1"])
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor, "in_2")
  assert.equal(serializeInvoicePage([invoice()], false).nextCursor, null)
})

test("the page size is bounded", () => {
  assert.equal(billingInvoicesQuerySchema.safeParse({ limit: "24" }).success, true)
  assert.equal(billingInvoicesQuerySchema.safeParse({ limit: "0" }).success, false)
  assert.equal(billingInvoicesQuerySchema.safeParse({ limit: "51" }).success, false)
})
