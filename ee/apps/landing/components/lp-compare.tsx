import {
  ArrowRightLeft,
  Check,
  Cloud,
  Cpu,
  KeyRound,
  Library,
  Minus,
  Monitor,
  Split,
  Users,
  type LucideIcon
} from "lucide-react";
import type { ReactNode } from "react";

import {
  compareCellText,
  type CompareCard,
  type CompareCell,
  type CompareColumn,
  type CompareIcon,
  type CompareRow,
  type CompareSource
} from "../lib/compare";
import { LpArrowLink } from "./lp-primitives";
import { OpenWorkMark } from "./openwork-mark";

const icons: Record<CompareIcon, LucideIcon> = {
  cpu: Cpu,
  key: KeyRound,
  monitor: Monitor,
  users: Users,
  cloud: Cloud,
  route: Split,
  library: Library,
  migrate: ArrowRightLeft
};

function Cell({ cell }: { cell: CompareCell }) {
  if (typeof cell === "string") return <span>{cell}</span>;
  const Icon = cell ? Check : Minus;
  return (
    <>
      <Icon
        aria-hidden="true"
        strokeWidth={cell ? 2 : 1.5}
        className={`inline-block h-4 w-4 ${cell ? "text-[var(--lp-ink)]" : "text-[var(--lp-muted)] opacity-60"}`}
      />
      <span className="sr-only">{compareCellText(cell)}</span>
    </>
  );
}

type CompareTableProps<Key extends string> = {
  caption: string;
  columns: CompareColumn<Key>[];
  rows: CompareRow<Key>[];
  /** Column rendered with the OpenWork mark and a tonal highlight. */
  highlight: Key;
  sources: CompareSource[];
  checkedAt?: string;
};

export function CompareTable<Key extends string>({
  caption,
  columns,
  rows,
  highlight,
  sources,
  checkedAt
}: CompareTableProps<Key>) {
  const last = rows.length - 1;
  return (
    <div>
      <table className="w-full table-fixed border-collapse text-left text-[13px] leading-[19px] md:text-[14.5px] md:leading-[22px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="w-[34%] md:w-[40%]">
              <span className="sr-only">Feature</span>
            </th>
            {columns.map((column) => {
              const on = column.key === highlight;
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={`px-2 pb-3 pt-4 text-center align-bottom text-[12.5px] md:px-4 md:text-[13.5px] ${
                    on ? "rounded-t-[16px] bg-[var(--lp-tonal)] font-semibold text-[var(--lp-ink)]" : "font-medium text-[var(--lp-muted)]"
                  }`}
                >
                  {on ? (
                    <span className="inline-flex flex-col items-center gap-1.5 md:flex-row md:gap-2">
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
          {rows.map((row, index) => (
            <tr key={row.label}>
              <th
                scope="row"
                className="border-t border-[var(--lp-border)] py-3.5 pr-3 font-normal text-[var(--lp-ink)] md:py-4"
              >
                {row.label}
              </th>
              {columns.map((column) => {
                const on = column.key === highlight;
                return (
                  <td
                    key={column.key}
                    className={`border-t px-2 py-3.5 text-center tabular-nums md:px-4 md:py-4 ${
                      on
                        ? `border-[var(--lp-page)] bg-[var(--lp-tonal)] font-medium text-[var(--lp-ink)] ${index === last ? "rounded-b-[16px]" : ""}`
                        : "border-[var(--lp-border)] text-[var(--lp-body)]"
                    }`}
                  >
                    <Cell cell={row[column.key]} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] leading-[20px] text-[var(--lp-muted)]">
        <span>{checkedAt ? `Sources, checked ${checkedAt}:` : "Sources:"}</span>
        {sources.map((source, index) => (
          <a
            key={source.href}
            href={source.href}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
          >
            <sup className="mr-0.5">{index + 1}</sup>
            {source.label}
          </a>
        ))}
      </p>
    </div>
  );
}

export function CompareCards({ cards }: { cards: CompareCard[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = icons[card.icon];
        return (
          <li key={card.title} className="flex flex-col rounded-[20px] bg-[var(--lp-tonal)] p-6">
            <Icon aria-hidden="true" strokeWidth={1.5} className="h-5 w-5 text-[var(--lp-ink)]" />
            <h3 className="mt-8 flex-1 text-[17px] font-medium leading-[24px] tracking-[-0.01em] [text-wrap:balance]">
              {card.title}
            </h3>
            <div className="mt-6">
              <LpArrowLink href={card.link.href}>{card.link.label}</LpArrowLink>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type PageHeroProps = {
  heading: string;
  sub: string;
  children: ReactNode;
  note?: string;
};

export function CompareHero({ heading, sub, children, note }: PageHeroProps) {
  return (
    <header className="pb-14 pt-16 text-center md:pb-20 md:pt-[104px]">
      <h1 className="mx-auto max-w-[820px] text-[40px] font-light leading-[46px] tracking-[-0.025em] [text-wrap:balance] md:text-[60px] md:leading-[64px]">
        {heading}
      </h1>
      <p className="mx-auto mt-6 max-w-[560px] text-[17px] leading-[27px] text-[var(--lp-body)] [text-wrap:balance] md:text-[18px] md:leading-[29px]">
        {sub}
      </p>
      <div className="mt-8 flex justify-center">{children}</div>
      {note ? <p className="mt-4 text-[13px] text-[var(--lp-muted)]">{note}</p> : null}
    </header>
  );
}

export function CompareSection({
  id,
  heading,
  children
}: {
  id: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="scroll-mt-28 py-14 md:py-20">
      <h2
        id={id}
        className="mb-9 text-[32px] font-light leading-[38px] tracking-[-0.015em] md:text-[40px] md:leading-[46px]"
      >
        {heading}
      </h2>
      {children}
    </section>
  );
}
