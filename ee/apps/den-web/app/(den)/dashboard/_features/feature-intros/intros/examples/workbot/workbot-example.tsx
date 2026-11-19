"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import {
  workbotExampleApps,
  workbotExampleModel,
  workbotExampleQuestion,
  workbotExampleReply,
  workbotExampleSteps,
} from "./workbot-example-data";

/** Section example: one question in Workbot, the apps it read to answer, and the team setup behind it. */
export function WorkbotExample() {
  const step = useExampleStep(workbotExampleSteps.length);

  return (
    <div>
      <ExampleCaption>Workbot, once running</ExampleCaption>

      <div className="flex justify-end">
        <p className="m-0 max-w-[85%] rounded-2xl bg-gray-100 px-3 py-1.5 text-[13px] leading-5 text-gray-900">{workbotExampleQuestion}</p>
      </div>

      <ul className="m-0 mt-3 flex list-none flex-col p-0">
        {workbotExampleSteps.map((item, index) => (
          <li
            key={item.sentence}
            className={`-mx-2 flex min-h-8 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors duration-200 ease-out ${step === index ? "bg-gray-50" : ""}`}
          >
            <ExampleServiceMark service={item.service} size="sm" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{item.sentence}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-gray-500">{item.result}</span>
          </li>
        ))}
      </ul>

      <p className="m-0 mt-2 text-[13px] leading-5 text-gray-900">{workbotExampleReply}</p>

      <div className="mt-4 border-t border-gray-100 pt-3">
        <ExampleGroupLabel>Set up for your team</ExampleGroupLabel>
        <ExampleRows>
          <ExampleRow>
            <ExampleServiceMark service={workbotExampleModel.service} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{workbotExampleModel.label}</span>
            <span className="shrink-0 text-[12px] text-gray-700">{workbotExampleModel.value}</span>
          </ExampleRow>
          <ExampleRow>
            <span className="flex shrink-0 items-center gap-1">
              {workbotExampleApps.services.map((service) => <ExampleServiceMark key={service.name} service={service} size="sm" />)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{workbotExampleApps.label}</span>
            <span className="shrink-0 text-[12px] text-gray-700">{workbotExampleApps.value}</span>
          </ExampleRow>
        </ExampleRows>
      </div>
    </div>
  );
}
