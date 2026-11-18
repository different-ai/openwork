"use client";

import { CheckCircle2 } from "lucide-react";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { deploymentsExample, deploymentsExampleChecks } from "./deployments-example-data";

/** Deployments example: one install in the customer's own cloud, its version and the health checks it reports. */
export function DeploymentsExample() {
  const step = useExampleStep(deploymentsExampleChecks.length);

  return (
    <div>
      <ExampleCaption>OpenWork in your own cloud</ExampleCaption>
      <div className="mb-4 flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">{deploymentsExample.name} · {deploymentsExample.address}</span>
          <span className="truncate text-[12px] text-gray-500">{deploymentsExample.where} · {deploymentsExample.version}</span>
        </span>
        <span className="shrink-0 text-[12px] text-gray-700">{deploymentsExample.status}</span>
      </div>
      <ExampleGroupLabel meta={deploymentsExample.reported}>Status checks</ExampleGroupLabel>
      <ExampleRows>
        {deploymentsExampleChecks.map((check, index) => (
          <ExampleRow key={check.label} active={step === index}>
            <CheckCircle2 className="size-4 shrink-0 text-gray-500" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[13px] text-gray-900">{check.label}</span>
            <span className="shrink-0 text-[12px] text-gray-500">{check.detail}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
