"use client";

import { Globe } from "lucide-react";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleServiceMark } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { webExampleChat } from "./web-example-data";

/** `?` example: a chat in the browser using the team's connectors, step by step. */
export function WebExample() {
  const step = useExampleStep(webExampleChat.steps.length);

  return (
    <div>
      <ExampleCaption>OpenWork in your browser</ExampleCaption>
      <div className="flex min-h-8 items-center gap-2 border-b border-gray-100 pb-2 text-[12px] text-gray-500">
        <Globe className="size-3.5" strokeWidth={1.5} />
        <span className="truncate">{webExampleChat.address}</span>
      </div>
      <div className="mb-2 mt-3 flex items-center gap-2.5">
        <ExampleAvatar>{webExampleChat.initials}</ExampleAvatar>
        <span className="min-w-0 truncate rounded-xl bg-gray-100 px-3 py-1.5 text-[12px] text-gray-800">{webExampleChat.prompt}</span>
      </div>
      <ExampleGroupLabel>Using your team&apos;s connectors</ExampleGroupLabel>
      <ul className="m-0 flex list-none flex-col p-0">
        {webExampleChat.steps.map((item, index) => (
          <li
            key={item.sentence}
            className={`-mx-2 flex min-h-8 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors duration-200 ease-out ${step === index ? "bg-gray-50" : ""}`}
          >
            <span className="flex size-6 shrink-0 items-center justify-center">
              {item.service ? <ExampleServiceMark service={item.service} size="sm" /> : <span className="size-1.5 rounded-full bg-gray-400" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{item.sentence}</span>
            {item.result ? <span className="shrink-0 text-[12px] tabular-nums text-gray-500">{item.result}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
