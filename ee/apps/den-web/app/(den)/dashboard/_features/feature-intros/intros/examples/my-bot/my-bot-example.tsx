"use client";

import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { myBotExample } from "./my-bot-example-data";

/** `?` example: the last check, today's checks and what the bot reads. */
export function MyBotExample() {
  const step = useExampleStep(myBotExample.today.length);

  return (
    <div>
      <ExampleCaption>{myBotExample.focal}</ExampleCaption>
      <p className="-mt-2 mb-3 text-[12px] leading-5 text-gray-600">{myBotExample.summary}</p>
      <ExampleGroupLabel>Today</ExampleGroupLabel>
      <ExampleRows>
        {myBotExample.today.map((check, index) => (
          <ExampleRow key={check.time} active={step === index}>
            <span className="w-16 shrink-0 text-[12px] tabular-nums text-gray-500">{check.time}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-gray-900">{check.text}</span>
            {check.sent ? <span className="shrink-0 text-[12px] text-gray-500">{check.sent}</span> : null}
          </ExampleRow>
        ))}
      </ExampleRows>
      <div className="mt-3 border-t border-gray-100 pt-3">
        <ExampleGroupLabel>What it reads</ExampleGroupLabel>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {myBotExample.reads.map((service) => (
            <span key={service.name} className="flex items-center gap-1.5 text-[12px] text-gray-700">
              <ExampleServiceMark service={service} size="sm" />
              {service.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
