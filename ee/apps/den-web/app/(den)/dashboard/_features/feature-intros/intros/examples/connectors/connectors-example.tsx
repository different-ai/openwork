"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { connectorsExampleActivity, connectorsExampleRows } from "./connectors-example-data";

/** Section example: the apps the team connected, who has each, and what people's AI did with them. */
export function ConnectorsExample() {
  const step = useExampleStep(connectorsExampleRows.length);
  const active = step === null ? null : connectorsExampleRows[step]?.service ?? null;

  return (
    <div>
      <ExampleCaption>Your connectors, once running</ExampleCaption>

      <ExampleRows>
        {connectorsExampleRows.map((row) => (
          <ExampleRow key={row.service.name} active={active === row.service}>
            <ExampleServiceMark service={row.service} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.service.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.signIn}</span>
            </span>
            <span className="max-w-[45%] shrink-0 truncate text-right text-[12px] text-gray-500">{row.audience}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <ExampleGroupLabel>What their AI did today</ExampleGroupLabel>
        <ul className="m-0 flex list-none flex-col p-0">
          {connectorsExampleActivity.map((item) => (
            <li
              key={item.sentence}
              className={`-mx-2 flex min-h-8 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors duration-200 ease-out ${active === item.service ? "bg-gray-50" : ""}`}
            >
              <ExampleServiceMark service={item.service} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{item.sentence}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-gray-500">{item.result}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
