"use client";

import { useExampleStep } from "../use-example-step";
import { apiKeysExampleRows } from "./api-keys-example-data";
import { ExampleAvatar, ExampleCaption, ExampleRow, ExampleRows } from "./example-parts";

/** Every member's AI Gateway API key: the tool it is for, who owns it and when it was last used. */
export function ApiKeysExample() {
  const step = useExampleStep(apiKeysExampleRows.length, 3000);
  return (
    <div>
      <ExampleCaption>API keys for 3rd party tools</ExampleCaption>
      <ExampleRows>
        {apiKeysExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            <ExampleAvatar>{row.initials}</ExampleAvatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.owner}, <span className="font-mono">{row.prefix}…</span></span>
            </span>
            <span className="shrink-0 text-right text-[12px] text-gray-500">{row.lastUsed}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
