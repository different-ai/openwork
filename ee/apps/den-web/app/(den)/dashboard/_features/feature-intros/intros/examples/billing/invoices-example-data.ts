import type { BillingInvoiceStatus } from "@openwork/types/den/billing-invoices";

/** Sample data only: no API calls (DESIGN.md I7). A Team plan for 6 people at $10 each. */
export const invoicesExampleRows: ReadonlyArray<{ date: string; number: string; amount: string; status: BillingInvoiceStatus }> = [
  { date: "1 Nov 2026", number: "A1B2C3D4-0003", amount: "$60.00", status: "open" },
  { date: "1 Oct 2026", number: "A1B2C3D4-0002", amount: "$60.00", status: "paid" },
  { date: "1 Sep 2026", number: "A1B2C3D4-0001", amount: "$50.00", status: "paid" },
];
