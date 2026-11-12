"use client";

import { LetterTile } from "../../../../../_components/item-logo";
import { useExampleStep } from "../use-example-step";
import { ExampleAvatar, ExampleRow, ExampleRows } from "../example-parts";
import { accessExamplePlugin, accessExampleWhere, accessExampleWho } from "./access-example-data";

/** Plugin page example: who can use it, and where it shows up for them. */
export function PluginAccessExample() {
  const step = useExampleStep(accessExampleWho.length);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <LetterTile name={accessExamplePlugin.name} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">Who can use {accessExamplePlugin.name}</span>
          <span className="text-[12px] leading-4 text-gray-500">{accessExamplePlugin.inside}</span>
        </span>
      </div>

      <ExampleRows>
        {accessExampleWho.map((who, index) => (
          <ExampleRow key={who.name} active={step === index}>
            <ExampleAvatar>{who.initials}</ExampleAvatar>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{who.name}</span>
            <span className="shrink-0 text-[12px] text-gray-500">{who.detail}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <p className="mt-3 border-t border-gray-100 pt-3 text-[12px] text-gray-500">{accessExampleWhere}</p>
    </div>
  );
}
