"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleAvatar, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { accessExampleService, accessExampleSignIn, accessExampleToolCount, accessExampleTools, accessExampleWho } from "./access-example-data";

/** Connector page example: who has it, how they sign in, and what their AI can do with it. */
export function ConnectorAccessExample() {
  const step = useExampleStep(accessExampleWho.length);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <ExampleServiceMark service={accessExampleService} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">Who can use {accessExampleService.name}</span>
          <span className="text-[12px] leading-4 text-gray-500">{accessExampleSignIn}</span>
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

      <div className="mt-3 border-t border-gray-100 pt-3">
        <ExampleGroupLabel meta={accessExampleToolCount}>What their AI can do</ExampleGroupLabel>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {accessExampleTools.map((tool) => (
            <li key={tool.title} className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{tool.title}</span>
              <span className="truncate text-[12px] text-gray-500">{tool.summary}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
