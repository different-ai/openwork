"use client";

import { KeyRound } from "lucide-react";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { apiKeysExampleRequest, apiKeysExampleRows } from "./api-keys-example-data";

/** API Keys example: named keys, who owns each and when it was last used, and the header a script sends. */
export function ApiKeysExample() {
  const step = useExampleStep(apiKeysExampleRows.length);

  return (
    <div>
      <ExampleCaption>Keys your scripts use</ExampleCaption>
      <ExampleRows>
        {apiKeysExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
              <KeyRound className="size-3.5" strokeWidth={1.5} aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="truncate text-[12px] text-gray-500"><span className="font-mono">{row.preview}</span> · {row.owner}</span>
            </span>
            <span className="shrink-0 text-[12px] text-gray-500">{row.lastUsed}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
      <div className="mt-4">
        <ExampleGroupLabel>From a script</ExampleGroupLabel>
        <p className="m-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg bg-gray-50 px-3 py-2 font-mono text-[11.5px] text-gray-700">{apiKeysExampleRequest}</p>
      </div>
    </div>
  );
}
