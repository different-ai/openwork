"use client";

import { Store } from "lucide-react";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import {
  collectionPluginsExampleAudience,
  collectionPluginsExampleRows,
  collectionsExampleRows,
} from "./collections-example-data";

/** Collections example: the built-in collection plus two of the organization's own, with who gets each. */
export function CollectionsExample() {
  const step = useExampleStep(collectionsExampleRows.length);

  return (
    <div>
      <ExampleCaption>Collections and who gets them</ExampleCaption>
      <ExampleRows>
        {collectionsExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            {row.builtIn ? (
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
                <Store className="size-3.5" strokeWidth={1.5} aria-hidden />
              </span>
            ) : <ExampleAvatar>{row.initials}</ExampleAvatar>}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.plugins}</span>
            </span>
            <span className="shrink-0 text-[12px] text-gray-500">{row.audience}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}

/** A collection's Plugins tab once filled: each plugin, what's inside, and one audience for all of them. */
export function CollectionPluginsExample() {
  const step = useExampleStep(collectionPluginsExampleRows.length);

  return (
    <div>
      <ExampleGroupLabel meta={collectionPluginsExampleAudience}>Sales enablement</ExampleGroupLabel>
      <ExampleRows>
        {collectionPluginsExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.contents}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {row.services.map((service) => <ExampleServiceMark key={service.name} service={service} size="sm" />)}
            </span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
