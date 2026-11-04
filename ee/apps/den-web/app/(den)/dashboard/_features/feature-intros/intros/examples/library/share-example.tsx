"use client";

import { LibraryKindIcon } from "../../../../../_components/library-compact";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { libraryShareExample } from "./library-example-data";

/** "Share with your team": a skill of yours and the team and person who can use it. */
export function LibraryShareExample() {
  const step = useExampleStep(libraryShareExample.people.length);

  return (
    <div>
      <ExampleCaption>Sharing your skill</ExampleCaption>
      <div className="flex min-h-11 items-center gap-3">
        <LibraryKindIcon kind="skill" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">{libraryShareExample.item}</span>
          <span className="truncate text-[12px] text-gray-500">{libraryShareExample.kind}</span>
        </span>
      </div>
      <div className="mt-2 border-t border-gray-100 pt-3">
        <ExampleGroupLabel>Who can use it</ExampleGroupLabel>
        <ExampleRows>
          <ExampleRow>
            <ExampleAvatar>You</ExampleAvatar>
            <span className="min-w-0 flex-1 truncate text-[13px] text-gray-900">You</span>
            <span className="shrink-0 text-[12px] text-gray-500">Owner</span>
          </ExampleRow>
          {libraryShareExample.people.map((person, index) => (
            <ExampleRow key={person.name} active={step === index}>
              <ExampleAvatar>{person.initials}</ExampleAvatar>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-gray-900">{person.name}</span>
                <span className="truncate text-[12px] text-gray-500">{person.detail}</span>
              </span>
              <span className="shrink-0 text-[12px] text-gray-500">Can use</span>
            </ExampleRow>
          ))}
        </ExampleRows>
      </div>
    </div>
  );
}
