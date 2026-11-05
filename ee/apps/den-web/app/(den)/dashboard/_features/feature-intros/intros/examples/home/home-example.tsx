"use client";

import { Users } from "lucide-react";
import { LibraryKindIcon } from "../../../../../_components/library-compact";
import { ExampleProviderMark } from "../ai-gateway/example-parts";
import { ExampleCaption, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { homeExample } from "./home-example-data";

/** `?` example: what everyone in the organization starts with when they sign in, and who uses it. */
export function HomeExample() {
  const step = useExampleStep(4);
  const { people, models, connectors, plugins } = homeExample;

  return (
    <div>
      <ExampleCaption>{`${homeExample.org}, once set up`}</ExampleCaption>
      <ExampleRows>
        <ExampleRow active={step === 0}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500"><Users className="size-3.5" strokeWidth={1.75} /></span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">People</span>
          <span className="shrink-0 text-[12px] tabular-nums text-gray-500">{`${people.active} of ${people.total} active this week`}</span>
        </ExampleRow>
        <ExampleRow active={step === 1}>
          <span className="flex shrink-0 items-center gap-1">
            {models.providers.map((provider) => <ExampleProviderMark key={provider.providerId} provider={provider} size="sm" />)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">Models</span>
          <span className="min-w-0 shrink truncate text-right text-[12px] text-gray-500">{models.text}</span>
        </ExampleRow>
        <ExampleRow active={step === 2}>
          <span className="flex shrink-0 items-center gap-1">
            {connectors.services.map((service) => <ExampleServiceMark key={service.name} service={service} size="sm" />)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">Connectors</span>
          <span className="shrink-0 text-[12px] text-gray-500">{connectors.text}</span>
        </ExampleRow>
        <ExampleRow active={step === 3}>
          <LibraryKindIcon kind="plugin" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium text-gray-900">Plugins</span>
            <span className="truncate text-[12px] text-gray-500">{plugins.names}</span>
          </span>
          <span className="shrink-0 text-[12px] text-gray-500">{plugins.text}</span>
        </ExampleRow>
      </ExampleRows>
    </div>
  );
}
