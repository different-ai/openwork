"use client";

import { ExampleProviderMark } from "../ai-gateway/example-parts";
import { ExampleCaption, ExampleGroupLabel, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import {
  libraryConnectorRows,
  type LibraryExampleRow,
  libraryModelKey,
  libraryModelRows,
  libraryPluginRows,
  librarySkillRows,
} from "./library-example-data";
import { LibraryExampleItem } from "./library-row";

function TabExample({ caption, rows }: { caption: string; rows: readonly LibraryExampleRow[] }) {
  const step = useExampleStep(rows.length);
  return (
    <div>
      <ExampleCaption>{caption}</ExampleCaption>
      <ExampleRows>
        {rows.map((row, index) => <LibraryExampleItem key={`${row.name}-${row.source}`} row={row} active={step === index} />)}
      </ExampleRows>
    </div>
  );
}

/** Library › Connectors: shared ones, one waiting on your sign-in, one you added. */
export function LibraryConnectorsExample() {
  return <TabExample caption="Your connectors" rows={libraryConnectorRows} />;
}

/** Library › Skills: two shared with you and one of yours. */
export function LibrarySkillsExample() {
  return <TabExample caption="Your skills" rows={librarySkillRows} />;
}

/** Library › Plugins: two plugins shared with you. */
export function LibraryPluginsExample() {
  return <TabExample caption="Your plugins" rows={libraryPluginRows} />;
}

/** Library › Models: models from the organization, one waiting on your sign-in, and your own key. */
export function LibraryModelsExample() {
  return <TabExample caption="Your models" rows={libraryModelRows} />;
}

/** "Use your own key": one provider key, who can use it and the models it brings. */
export function LibraryModelKeyExample() {
  const step = useExampleStep(libraryModelKey.models.length);
  return (
    <div>
      <ExampleCaption>Your key</ExampleCaption>
      <div className="flex min-h-11 items-center gap-3">
        <ExampleProviderMark provider={libraryModelKey.provider} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{libraryModelKey.name}</span>
        <span className="shrink-0 text-[12px] text-gray-500">{libraryModelKey.access}</span>
      </div>
      <div className="mt-2 border-t border-gray-100 pt-3">
        <ExampleGroupLabel meta={libraryModelKey.models.length}>Models it gives you</ExampleGroupLabel>
        <ul className="m-0 flex list-none flex-col p-0">
          {libraryModelKey.models.map((model, index) => (
            <li
              key={model}
              className={`-mx-2 flex min-h-8 items-center rounded-lg px-2 py-1 text-[13px] text-gray-800 transition-colors duration-200 ease-out ${step === index ? "bg-gray-50" : ""}`}
            >
              {model}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
