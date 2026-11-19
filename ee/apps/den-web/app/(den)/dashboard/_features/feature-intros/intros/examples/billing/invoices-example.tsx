"use client";

import { BillingInvoiceRow } from "../../../../../_components/billing-invoice-row";
import { ExampleCaption } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { invoicesExampleRows } from "./invoices-example-data";

/** Invoices example: the same rows the Invoices page shows, one invoice a month. */
export function InvoicesExample() {
  const step = useExampleStep(invoicesExampleRows.length);

  return (
    <div>
      <ExampleCaption>Your invoices</ExampleCaption>
      <ul className="m-0 list-none divide-y divide-gray-100 p-0">
        {invoicesExampleRows.map((row, index) => (
          <BillingInvoiceRow key={row.number} {...row} inset="example" active={step === index} />
        ))}
      </ul>
    </div>
  );
}
