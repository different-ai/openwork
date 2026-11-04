"use client";

import { ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { toolTesterExample, toolTesterExampleTools } from "./tool-tester-example-data";

/** Tool Tester example: one run against a connector with your own sign-in, and tools turned on or off for everyone. */
export function ToolTesterExample() {
  const step = useExampleStep(toolTesterExampleTools.length);

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <ExampleServiceMark service={toolTesterExample.service} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{toolTesterExample.connection}</span>
        <span className="shrink-0 text-[12px] text-gray-500">{toolTesterExample.signedIn}</span>
      </div>
      <p className="m-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg bg-gray-50 px-3 py-2 font-mono text-[11.5px] text-gray-700">
        {toolTesterExample.tool} {toolTesterExample.args}
      </p>
      <p className="mb-3 mt-1.5 text-[12px] text-gray-500">{toolTesterExample.result}</p>
      <ExampleGroupLabel>Tools your organization can use</ExampleGroupLabel>
      <ExampleRows>
        {toolTesterExampleTools.map((tool, index) => (
          <ExampleRow key={tool.name} active={step === index}>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-900">{tool.name}</span>
            <span className="shrink-0 text-[12px] text-gray-500">{tool.on ? "On" : "Off"}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
