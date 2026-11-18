"use client";

import { ExampleCaption, ExampleGroupLabel, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { libraryExampleGroups } from "./library-example-data";
import { LibraryExampleItem } from "./library-row";

const rows = libraryExampleGroups.flatMap((group) => group.rows);

/** Section example: a member's Library once the team shares, what waits on them first, then theirs. */
export function LibraryExample() {
  const step = useExampleStep(rows.length);
  const active = step === null ? null : rows[step] ?? null;

  return (
    <div>
      <ExampleCaption>Your Library, once your team shares</ExampleCaption>
      <div className="flex flex-col gap-3">
        {libraryExampleGroups.map((group) => (
          <div key={group.title}>
            <ExampleGroupLabel meta={group.rows.length}>{group.title}</ExampleGroupLabel>
            <ExampleRows>
              {group.rows.map((row) => <LibraryExampleItem key={row.name} row={row} active={active === row} />)}
            </ExampleRows>
          </div>
        ))}
      </div>
    </div>
  );
}
