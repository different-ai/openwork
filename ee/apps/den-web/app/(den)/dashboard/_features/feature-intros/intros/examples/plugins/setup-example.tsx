"use client";

import { Check, FileText, SquareTerminal } from "lucide-react";
import { LetterTile } from "../../../../../_components/item-logo";
import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { GITHUB } from "./plugins-example-data";
import { createExampleFootnote, createExampleInside, createExamplePlugin, importExampleItems, importExampleUrl, skillExample } from "./setup-example-data";

function KindMark({ kind }: { kind: "Skill" | "Command" }) {
  const Icon = kind === "Skill" ? FileText : SquareTerminal;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-gray-50 text-gray-500">
      <Icon className="size-4" strokeWidth={1.5} />
    </span>
  );
}

/** Create a plugin example: a skill, a command and a connector added one by one; all shown under reduced motion. */
export function PluginCreateExample() {
  const step = useExampleStep(createExampleInside.length + 1, 1800);
  const shown = step === null ? createExampleInside.length : step;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <LetterTile name={createExamplePlugin.name} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">{createExamplePlugin.name}</span>
          <span className="truncate text-[12px] text-gray-500">{createExamplePlugin.description}</span>
        </span>
      </div>

      <ExampleGroupLabel meta={`${shown} of ${createExampleInside.length}`}>What&apos;s inside</ExampleGroupLabel>
      <ExampleRows>
        {createExampleInside.map((item, index) => {
          const added = index < shown;
          const title = item.kind === "Connector" ? item.service.name : item.title;
          return (
            <ExampleRow key={title} active={index === shown - 1 && step !== null}>
              {item.kind === "Connector" ? <ExampleServiceMark service={item.service} /> : <KindMark kind={item.kind} />}
              <span className={`flex min-w-0 flex-1 flex-col transition-opacity duration-200 ease-out ${added ? "" : "opacity-40"}`}>
                <span className={`truncate text-[13px] font-medium text-gray-900 ${item.kind === "Command" ? "font-mono" : ""}`}>{title}</span>
                <span className="truncate text-[12px] text-gray-500">{item.detail}</span>
              </span>
              <span className="shrink-0 text-[12px] text-gray-500">{item.kind}</span>
            </ExampleRow>
          );
        })}
      </ExampleRows>
      <p className="mt-3 border-t border-gray-100 pt-3 text-[12px] text-gray-500">{createExampleFootnote}</p>
    </div>
  );
}

/** Import from GitHub example: the preview of a public plugin, with what can and can't come in. */
export function PluginImportExample() {
  const step = useExampleStep(importExampleItems.length);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <ExampleServiceMark service={GITHUB} />
        <span className="min-w-0 truncate rounded-lg border border-gray-200 px-2.5 py-1 text-[12px] text-gray-700">{importExampleUrl}</span>
      </div>
      <ExampleGroupLabel meta="3 selected">Found in this plugin</ExampleGroupLabel>
      <ExampleRows>
        {importExampleItems.map((item, index) => (
          <ExampleRow key={item.name} active={step === index}>
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-[6px] border ${item.supported ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-gray-50"}`}
            >
              {item.supported ? <Check className="size-3" strokeWidth={2} /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`truncate text-[13px] font-medium ${item.supported ? "text-gray-900" : "text-gray-500"}`}>{item.name}</span>
              <span className="truncate text-[12px] text-gray-500">{item.status}</span>
            </span>
            <span className="shrink-0 text-[12px] text-gray-500">{item.kind}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}

/** Skill editor example: a skill's name, when the AI uses it, and its steps in plain words. */
export function PluginSkillExample() {
  return (
    <div>
      <ExampleCaption>A skill, written down once</ExampleCaption>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] text-gray-500">Name</span>
          <span className="truncate font-mono text-[13px] text-gray-900">{skillExample.name}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] text-gray-500">Description</span>
          <span className="text-[13px] text-gray-900">{skillExample.description}</span>
        </div>
        <div className="flex flex-col gap-1 border-t border-gray-100 pt-3">
          <span className="text-[12px] text-gray-500">Skill body</span>
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13px] text-gray-700">
            {skillExample.steps.map((line) => <li key={line}>{line}</li>)}
          </ol>
        </div>
      </div>
    </div>
  );
}
