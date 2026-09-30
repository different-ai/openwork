import { Fragment } from "react";

import {
  capabilitiesCheckedAt,
  capabilityColumns,
  capabilityFootnotes,
  capabilityGroups,
  capabilityRows,
  capabilitySources,
  capabilitySubtitle,
  footnoteId,
  seatPrice,
  supportLabel,
  supportTotals,
  type CapabilityCell,
  type ProductKey
} from "../lib/cowork-capabilities";
import { OpenWorkMark } from "./openwork-mark";

const valueClass: Record<CapabilityCell["value"], string> = {
  yes: "font-semibold text-[var(--lp-ink)]",
  partial: "text-[var(--lp-body)]",
  no: "text-[var(--lp-muted)] opacity-70"
};

function MatrixCell({ cell, number }: { cell: CapabilityCell; number?: number }) {
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <span className={valueClass[cell.value]}>
        {supportLabel(cell.value)}
        {number ? (
          <sup className="ml-0.5 text-[10px] font-normal text-[var(--lp-muted)]">
            <a href={`#capability-note-${number}`} aria-label={`Note ${number}`}>
              {number}
            </a>
          </sup>
        ) : null}
      </span>
      {cell.planned ? (
        <a
          href="/roadmap"
          className="text-[11px] font-medium leading-[14px] text-[var(--lp-blue)] underline decoration-transparent underline-offset-2 hover:decoration-[var(--lp-blue)]"
        >
          Planned
        </a>
      ) : null}
    </span>
  );
}

type Props = {
  caption: string;
  /** Column whose header reads in full ink, for pages focused on it. */
  emphasis?: ProductKey;
};

export function CapabilityMatrix({ caption, emphasis }: Props) {
  const footnotes = capabilityFootnotes();
  const numbers = new Map(footnotes.map((note) => [note.id, note.number]));
  const tonal = (key: ProductKey) => (key === "openwork" ? "bg-[var(--lp-tonal)]" : "");

  return (
    <div>
      <p className="mb-6 max-w-[640px] text-[15px] leading-[24px] text-[var(--lp-body)]">{capabilitySubtitle()}</p>
      <div className="-mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
        <table className="w-full min-w-[340px] table-fixed border-collapse text-left text-[13px] leading-[19px] md:text-[14.5px] md:leading-[22px]">
          <caption className="sr-only">{caption}</caption>
          <colgroup>
            <col className="w-[40%] md:w-[46%]" />
            {capabilityColumns.map((column) => (
              <col key={column.key} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b-2 border-[var(--lp-ink)]">
              <th scope="col" className="sticky left-0 z-10 bg-[var(--lp-page)] pb-3 pr-3 align-bottom text-[12.5px] font-medium text-[var(--lp-muted)] md:text-[13.5px]">
                Capability
              </th>
              {capabilityColumns.map((column) => {
                const openwork = column.key === "openwork";
                const strong = openwork || column.key === emphasis;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={`rounded-t-[12px] px-1.5 pb-3 pt-3 text-center align-bottom text-[12.5px] md:px-4 md:text-[13.5px] ${tonal(column.key)} ${
                      openwork ? "font-semibold text-[var(--lp-blue)]" : strong ? "font-semibold text-[var(--lp-ink)]" : "font-medium text-[var(--lp-muted)]"
                    }`}
                  >
                    {openwork ? (
                      <span className="inline-flex flex-col items-center gap-1 md:flex-row md:gap-2">
                        <OpenWorkMark className="h-4 w-4 object-contain" />
                        {column.label}
                      </span>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {capabilityGroups.map((group) => (
              <Fragment key={group.label}>
                <tr>
                  <th
                    scope="colgroup"
                    className="sticky left-0 z-10 bg-[var(--lp-page)] pb-2 pr-3 pt-7 text-[13px] font-semibold text-[var(--lp-ink)] md:text-[14px]"
                  >
                    {group.label}
                  </th>
                  {capabilityColumns.map((column) => (
                    <td key={column.key} className={tonal(column.key)} />
                  ))}
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.label}>
                    <th
                      scope="row"
                      className="sticky left-0 z-10 border-t border-[var(--lp-border)] bg-[var(--lp-page)] py-2.5 pr-3 font-normal text-[var(--lp-ink)] md:py-3"
                    >
                      {row.label}
                    </th>
                    {capabilityColumns.map((column) => (
                      <td
                        key={column.key}
                        className={`border-t px-1.5 py-2.5 text-center md:px-4 md:py-3 ${
                          column.key === "openwork" ? "border-[var(--lp-page)] bg-[var(--lp-tonal)]" : "border-[var(--lp-border)]"
                        }`}
                      >
                        <MatrixCell cell={row.cells[column.key]} number={numbers.get(footnoteId(row, column.key))} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--lp-ink)]">
              <th scope="row" className="sticky left-0 z-10 bg-[var(--lp-page)] py-4 pr-3 font-semibold text-[var(--lp-ink)]">
                Yes, of {capabilityRows.length}
              </th>
              {capabilityColumns.map((column) => {
                const totals = supportTotals(column.key);
                return (
                  <td key={column.key} className={`px-1.5 py-4 text-center tabular-nums md:px-4 ${tonal(column.key)}`}>
                    <span
                      className={`block text-[20px] font-semibold leading-[24px] md:text-[24px] md:leading-[28px] ${
                        column.key === "openwork" ? "text-[var(--lp-blue)]" : "text-[var(--lp-ink)]"
                      }`}
                    >
                      {totals.yes}
                    </span>
                    {totals.partial > 0 ? (
                      <span className="block text-[12px] leading-[16px] text-[var(--lp-muted)]">+{totals.partial} partial</span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
            <tr>
              <th scope="row" className="sticky left-0 z-10 border-t border-[var(--lp-border)] bg-[var(--lp-page)] py-3 pr-3 text-[12.5px] font-normal text-[var(--lp-muted)]">
                Price per person, per month
              </th>
              {capabilityColumns.map((column) => (
                <td
                  key={column.key}
                  className={`rounded-b-[12px] border-t px-1.5 py-3 text-center text-[12.5px] text-[var(--lp-body)] md:px-4 ${
                    column.key === "openwork" ? "border-[var(--lp-page)] bg-[var(--lp-tonal)]" : "border-[var(--lp-border)]"
                  }`}
                >
                  {seatPrice[column.key]}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      <ol className="mt-6 grid gap-1 text-[12.5px] leading-[19px] text-[var(--lp-muted)] md:grid-cols-2 md:gap-x-8">
        {footnotes.map((note) => (
          <li key={note.id} id={`capability-note-${note.number}`} className="flex gap-2">
            <span className="w-4 shrink-0 text-right tabular-nums">{note.number}</span>
            <span>
              {note.note}{" "}
              <a
                href={note.source}
                {...(note.source.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                className="underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
              >
                Source
              </a>
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] leading-[20px] text-[var(--lp-muted)]">
        <span>Planned links to the public roadmap and never counts as Yes. Sources, checked {capabilitiesCheckedAt}:</span>
        {capabilitySources.map((source) => (
          <a
            key={source.href}
            href={source.href}
            {...(source.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
            className="underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
          >
            {source.label}
          </a>
        ))}
      </p>
    </div>
  );
}
