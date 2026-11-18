"use client";

import { Cloud, Monitor } from "lucide-react";
import { LetterTile } from "../../../../../_components/item-logo";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { automationsExampleGroups } from "./automations-example-data";

const items = automationsExampleGroups.flatMap((group) => group.items);

/** Section example: one Automation running, two scheduled, on OpenWork Cloud and on a desktop. */
export function AutomationsExample() {
  const step = useExampleStep(items.length);
  const active = step === null ? null : items[step] ?? null;

  return (
    <div>
      <ExampleCaption>Your Automations, once running</ExampleCaption>
      <div className="flex flex-col gap-3">
        {automationsExampleGroups.map((group) => (
          <div key={group.title}>
            <ExampleGroupLabel>{group.title}</ExampleGroupLabel>
            <ExampleRows>
              {group.items.map((item) => (
                <ExampleRow key={item.name} active={active === item}>
                  <LetterTile name={item.name} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium text-gray-900">{item.name}</span>
                    <span className="truncate text-[12px] text-gray-500">{item.schedule}</span>
                    <span className="truncate text-[12px] text-gray-500">{item.status}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[12px] text-gray-500">
                    {item.placement === "cloud" ? <Cloud className="size-3.5" strokeWidth={1.5} /> : <Monitor className="size-3.5" strokeWidth={1.5} />}
                    {item.placement === "cloud" ? "Cloud" : "Desktop"}
                  </span>
                </ExampleRow>
              ))}
            </ExampleRows>
          </div>
        ))}
      </div>
    </div>
  );
}
