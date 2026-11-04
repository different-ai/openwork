"use client";

import { ArrowDown } from "lucide-react";
import { useExampleStep } from "../use-example-step";
import {
  ExampleAvatar,
  ExampleCaption,
  ExampleGroupLabel,
  ExampleProviderMark,
  ExampleProviderMarks,
  ExampleRow,
  ExampleRows,
} from "./example-parts";
import { gatewayExampleAudiences, gatewayExampleProviders, gatewayExampleTotal } from "./gateway-example-data";

/** Neutral shades per audience; colour is kept for states that need attention (V2). */
const SPEND_TONES = ["bg-gray-900", "bg-gray-500", "bg-gray-300"];

/** Section example: providers in, teams out, spend at a glance. */
export function AiGatewayExample() {
  const step = useExampleStep(gatewayExampleAudiences.length);
  const activeAudience = step === null ? null : gatewayExampleAudiences[step];

  return (
    <div>
      <ExampleCaption>Your gateway, once running</ExampleCaption>

      <ExampleGroupLabel>Providers</ExampleGroupLabel>
      <ExampleRows>
        {gatewayExampleProviders.map(({ provider, detail }) => (
          <ExampleRow key={provider.providerId} active={activeAudience?.providers.includes(provider) ?? false}>
            <ExampleProviderMark provider={provider} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{provider.name}</span>
            <span className="shrink-0 text-[12px] text-gray-500">{detail}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="my-2 flex items-center gap-2 text-[12px] text-gray-500">
        <ArrowDown className="size-3.5 shrink-0" strokeWidth={1.5} />
        One AI Gateway key per person, no provider keys
      </div>

      <ExampleGroupLabel>Who can use them</ExampleGroupLabel>
      <ExampleRows>
        {gatewayExampleAudiences.map((audience) => (
          <ExampleRow key={audience.name} active={activeAudience === audience}>
            <ExampleAvatar>{audience.initials}</ExampleAvatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{audience.name}</span>
              <span className="truncate text-[12px] text-gray-500">{audience.people}</span>
            </span>
            <ExampleProviderMarks providers={audience.providers} />
            <span className="w-11 shrink-0 text-right text-[13px] font-semibold tabular-nums text-gray-950">{audience.spend}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="mt-3 flex flex-col gap-2 border-t border-gray-100 pt-3">
        <div className="flex items-baseline gap-3">
          <span className="flex-1 text-[12px] text-gray-500">Spend, last 31 days</span>
          <span className="text-[13px] font-semibold tabular-nums text-gray-950">{gatewayExampleTotal}</span>
        </div>
        <span className="flex h-1 gap-0.5 overflow-hidden rounded-full">
          {gatewayExampleAudiences.map((audience, index) => (
            <span
              key={audience.name}
              className={`h-1 rounded-full transition-opacity duration-200 ease-out ${SPEND_TONES[index] ?? "bg-gray-300"} ${activeAudience && activeAudience !== audience ? "opacity-40" : ""}`}
              style={{ flexGrow: audience.spendShare }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
