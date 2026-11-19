"use client";

import { ExampleCaption, ExampleProviderMark, ExampleRow, ExampleRows } from "./example-parts";
import { providersExampleRows } from "./providers-example-data";

/** Provider rows as on AI Providers: models, who can use them, status. */
export function ProvidersExample() {
  return (
    <div>
      <ExampleCaption>Your providers</ExampleCaption>
      <ExampleRows>
        {providersExampleRows.map((row) => {
          const ready = row.status === "Ready";
          return (
            <ExampleRow key={row.provider.providerId}>
              <ExampleProviderMark provider={row.provider} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-gray-900">{row.provider.name}</span>
                <span className="truncate text-[12px] text-gray-500">{row.models}, {row.audience}</span>
              </span>
              <span className={`flex shrink-0 items-center gap-2 text-[12px] ${ready ? "text-gray-600" : "text-amber-700"}`}>
                <span className={`size-1.5 rounded-full ${ready ? "bg-emerald-500" : "bg-amber-500"}`} />
                {row.status}
              </span>
            </ExampleRow>
          );
        })}
      </ExampleRows>
    </div>
  );
}
