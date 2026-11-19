"use client";

import { ExampleProviderMark } from "../ai-gateway/example-parts";
import { ExampleCaption, ExampleGroupLabel } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { analyticsExampleDaily, analyticsExampleModels, analyticsExampleStats } from "./analytics-example-data";

/** Section example: this week's adoption, daily active people and sessions by model, laid out like the real cards. */
export function AnalyticsExample() {
  const step = useExampleStep(analyticsExampleModels.length);
  const maxDay = Math.max(...analyticsExampleDaily);
  const maxModel = analyticsExampleModels[0]?.sessions ?? 0;

  return (
    <div>
      <ExampleCaption>Your team's usage, once people use it</ExampleCaption>

      <ExampleGroupLabel>This week</ExampleGroupLabel>
      <dl className="m-0 mb-4 grid grid-cols-3 gap-3">
        {analyticsExampleStats.map((stat) => (
          <div key={stat.title} className="min-w-0">
            <dt className="truncate text-[12px] text-gray-700">{stat.title}</dt>
            <dd className="m-0 text-[18px] font-semibold leading-6 tabular-nums text-gray-950">{stat.value}</dd>
            <dd className="m-0 truncate text-[12px] text-gray-500">{stat.sub}</dd>
          </div>
        ))}
      </dl>

      <ExampleGroupLabel meta="Last 14 days">Daily active users</ExampleGroupLabel>
      <div className="mb-4 flex h-14 items-end gap-1">
        {analyticsExampleDaily.map((value, index) => (
          <span
            key={index}
            className={`flex-1 rounded-[3px] ${index === analyticsExampleDaily.length - 1 ? "bg-gray-900" : "bg-gray-300"}`}
            style={{ height: `${Math.max(8, Math.round((value / maxDay) * 100))}%` }}
          />
        ))}
      </div>

      <ExampleGroupLabel meta="Sessions">Sessions by model</ExampleGroupLabel>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {analyticsExampleModels.map((model, index) => (
          <li
            key={model.label}
            className={`-mx-2 rounded-lg px-2 py-1.5 transition-colors duration-200 ease-out ${step === index ? "bg-gray-50" : ""}`}
          >
            <span className="flex items-center gap-2">
              <ExampleProviderMark provider={model.provider} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{model.label}</span>
              <span className="shrink-0 text-[13px] tabular-nums text-gray-700">{model.sessions}</span>
            </span>
            <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-gray-100">
              <span className="block h-1 rounded-full bg-gray-900" style={{ width: `${Math.round((model.sessions / maxModel) * 100)}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
