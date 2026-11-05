import { LibraryKindIcon } from "../../../../../_components/library-compact";
import { ExampleProviderMark } from "../ai-gateway/example-parts";
import { ExampleRow, ExampleServiceMark } from "../example-parts";
import type { LibraryExampleRow } from "./library-example-data";

function RowMark({ row }: { row: LibraryExampleRow }) {
  if (row.provider) return <ExampleProviderMark provider={row.provider} size="sm" />;
  if (row.service) return <ExampleServiceMark service={row.service} size="sm" />;
  return <LibraryKindIcon kind={row.kind === "plugin" ? "plugin" : "skill"} />;
}

/** One My Library row on sample data: mark, name and detail, then who gave it or the sign-in it waits on. */
export function LibraryExampleItem({ row, active }: { row: LibraryExampleRow; active: boolean }) {
  return (
    <ExampleRow active={active}>
      <RowMark row={row} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
        <span className="truncate text-[12px] text-gray-500">{row.detail}</span>
      </span>
      {row.signIn ? (
        <span className="shrink-0 rounded-md border border-gray-200 px-2 py-0.5 text-[12px] font-medium text-gray-700">Sign in</span>
      ) : (
        <span className="max-w-[40%] shrink-0 truncate text-right text-[12px] text-gray-500">{row.source}</span>
      )}
    </ExampleRow>
  );
}
