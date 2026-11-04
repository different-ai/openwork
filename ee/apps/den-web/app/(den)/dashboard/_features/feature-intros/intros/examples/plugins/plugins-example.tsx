"use client";

import { FileText } from "lucide-react";
import { LetterTile } from "../../../../../_components/item-logo";
import { useExampleStep } from "../use-example-step";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { GITHUB, pluginsExampleChat, pluginsExampleRows, type PluginsExampleRow } from "./plugins-example-data";

function sourceLabel(source: PluginsExampleRow["source"]): string {
  return source.kind === "here" ? "Made here" : `From ${source.repo}`;
}

/** Section example: three shared plugins, then one of them at work in someone's chat. */
export function PluginsExample() {
  const step = useExampleStep(pluginsExampleChat.steps.length);

  return (
    <div>
      <ExampleCaption>Your plugins, once shared</ExampleCaption>

      <ExampleRows>
        {pluginsExampleRows.map((row) => (
          <ExampleRow key={row.name} active={step !== null && row.name === "Release notes"}>
            <LetterTile name={row.name} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.inside}</span>
              <span className="truncate text-[12px] text-gray-500">{sourceLabel(row.source)}</span>
            </span>
            <span className="max-w-[35%] shrink-0 truncate text-right text-[12px] text-gray-500">{row.audience}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <ExampleGroupLabel>In someone&apos;s OpenWork</ExampleGroupLabel>
        <div className="mb-2 mt-2 flex items-center gap-2.5">
          <ExampleAvatar>{pluginsExampleChat.initials}</ExampleAvatar>
          <span className="min-w-0 truncate rounded-xl bg-gray-100 px-3 py-1.5 text-[12px] text-gray-800">{pluginsExampleChat.prompt}</span>
        </div>
        <ul className="m-0 flex list-none flex-col p-0">
          {pluginsExampleChat.steps.map((item, index) => (
            <li
              key={item.sentence}
              className={`-mx-2 flex min-h-8 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors duration-200 ease-out ${step === index ? "bg-gray-50" : ""}`}
            >
              <span className="flex size-6 shrink-0 items-center justify-center text-gray-500">
                {index === 0 ? <FileText className="size-3.5" strokeWidth={1.5} /> : index === 1 ? <ExampleServiceMark service={GITHUB} size="sm" /> : <span className="size-1.5 rounded-full bg-gray-400" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{item.sentence}</span>
              {item.result ? <span className="shrink-0 text-[12px] tabular-nums text-gray-500">{item.result}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
