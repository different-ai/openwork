"use client";

import { RefreshCw } from "lucide-react";
import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { GITHUB } from "./plugins-example-data";
import { sourcesExampleAccount, sourcesExampleRepos, sourcesExampleUpdate } from "./sources-example-data";

/** Sources example: a connected GitHub account, its repositories, and a change arriving on its own. */
export function PluginSourcesExample() {
  const step = useExampleStep(sourcesExampleRepos.length + 1);

  return (
    <div>
      <ExampleCaption>Your sources, once connected</ExampleCaption>
      <div className="mb-2 flex items-center gap-2.5">
        <ExampleServiceMark service={GITHUB} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">{sourcesExampleAccount.login}</span>
          <span className="truncate text-[12px] text-gray-500">{sourcesExampleAccount.connectedBy}</span>
        </span>
      </div>

      <ExampleGroupLabel>Repositories</ExampleGroupLabel>
      <ExampleRows>
        {sourcesExampleRepos.map((row, index) => (
          <ExampleRow key={row.repo} active={step === index}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.repo}</span>
              <span className="truncate text-[12px] text-gray-500">{row.synced}</span>
            </span>
            <span className="shrink-0 text-[12px] text-gray-500">{row.plugins}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div
        className={`-mx-2 mt-2 flex min-h-8 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors duration-200 ease-out ${step === sourcesExampleRepos.length ? "bg-gray-50" : ""}`}
      >
        <RefreshCw className="size-3.5 shrink-0 text-gray-500" strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{sourcesExampleUpdate.sentence}</span>
        <span className="shrink-0 text-[12px] text-gray-500">{sourcesExampleUpdate.result}</span>
      </div>
    </div>
  );
}
