"use client";

import { useState } from "react";
import { humanizeIdentifier } from "./workflow-plain-language";

const CARD_TITLE_KEYS = ["title", "name", "subject", "label", "id"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown[]): value is Record<string, unknown>[] {
  return value.every(isPlainObject);
}

function isCollection(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateValue(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value: Date): string {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCardDate(value: Date): string {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatCardTime(value: Date): string {
  return value.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function LongText({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= 240) return <>{value}</>;
  return (
    <span>
      {expanded ? value : `${value.slice(0, 240).trimEnd()}…`}{" "}
      <button type="button" className="font-medium text-blue-700 hover:text-blue-800" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Show less" : "Show more"}
      </button>
    </span>
  );
}

/** `**bold**` inside one line of text, rendered as React text (never as HTML). */
function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return <>{parts.map((part, index) => part.startsWith("**") && part.endsWith("**") && part.length > 4
    ? <strong key={index} className="font-semibold text-gray-900">{part.slice(2, -2)}</strong>
    : <span key={index}>{part}</span>)}</>;
}

/** Text written in lines (a brief, a summary): paragraphs and "- " bullets, as the workflow wrote them. */
function isReadableText(value: unknown): value is string {
  return typeof value === "string" && value.includes("\n") && !isoDate(value);
}

function ReadableText({ value }: { value: string }) {
  const lines = decodeHtmlEntities(value).split("\n");
  return (
    <div className="space-y-1 text-[13px] leading-6 text-gray-700" data-testid="den-workflow-readable-text">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={index} className="h-2" aria-hidden="true" />;
        const bullet = /^[-*•]\s+/.exec(trimmed);
        return bullet ? (
          <p key={index} className="flex gap-2 pl-1"><span className="text-gray-400" aria-hidden="true">•</span><span className="min-w-0"><InlineText text={trimmed.slice(bullet[0].length)} /></span></p>
        ) : <p key={index}><InlineText text={trimmed} /></p>;
      })}
    </div>
  );
}

function ScalarValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="text-gray-400">None</span>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "number") return <>{value.toLocaleString()}</>;
  if (typeof value === "string") {
    const date = isoDate(value);
    return <LongText value={date ? formatDateTime(date) : decodeHtmlEntities(value)} />;
  }
  return <LongText value={String(value)} />;
}

function DefinitionList({ entries }: { entries: [string, unknown][] }) {
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(8rem,0.4fr)_minmax(0,1fr)] gap-x-5 gap-y-3 text-[13px]">
      {entries.map(([key, value]) => (
        <div className="contents" key={key}>
          <dt className="text-gray-500">{humanizeIdentifier(key)}</dt>
          <dd className="min-w-0 break-words font-medium text-gray-800"><ScalarValue value={value} /></dd>
        </div>
      ))}
    </dl>
  );
}

function ObjectValue({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <EmptyValue />;
  const scalars = entries.filter((entry) => !isCollection(entry[1]) && !isReadableText(entry[1]));
  const collections = entries.filter((entry) => isCollection(entry[1]) || isReadableText(entry[1]));
  // A result that is only a written brief reads as the brief, without a label above it.
  const onlyText = scalars.length === 0 && collections.length === 1 && isReadableText(collections[0]?.[1]);
  if (onlyText) return <ReadableText value={collections[0]?.[1] as string} />;
  return (
    <div className="space-y-5">
      <DefinitionList entries={scalars} />
      {collections.map(([key, nested]) => (
        <section className="space-y-2 border-t border-gray-100 pt-4" key={key}>
          <h3 className="text-[12px] font-medium text-gray-600">{humanizeIdentifier(key)}</h3>
          {isReadableText(nested) ? <ReadableText value={nested} /> : <FriendlyValueContent value={nested} />}
        </section>
      ))}
    </div>
  );
}

function cardTitle(item: Record<string, unknown>, index: number): { key: string | null; text: string } {
  const key = CARD_TITLE_KEYS.find((candidate) => candidate in item && !isCollection(item[candidate]) && item[candidate] !== null);
  if (!key) return { key: null, text: `Item ${index + 1}` };
  const value = item[key];
  return { key, text: typeof value === "string" ? decodeHtmlEntities(value) : String(value) };
}

function cardDate(item: Record<string, unknown>): { keys: string[]; text: string | null } {
  const start = dateValue(item.start);
  const end = dateValue(item.end);
  const date = dateValue(item.date);
  if (start && end) {
    const sameDay = start.toLocaleDateString("en-US") === end.toLocaleDateString("en-US");
    return {
      keys: ["start", "end"],
      text: sameDay
        ? `${formatCardDate(start)}, ${formatCardTime(start)} – ${formatCardTime(end)}`
        : `${formatCardDate(start)}, ${formatCardTime(start)} – ${formatCardDate(end)}, ${formatCardTime(end)}`,
    };
  }
  if (start) return { keys: ["start"], text: `${formatCardDate(start)}, ${formatCardTime(start)}` };
  if (date) return { keys: ["date"], text: `${formatCardDate(date)}, ${formatCardTime(date)}` };
  if (end) return { keys: ["end"], text: `${formatCardDate(end)}, ${formatCardTime(end)}` };
  return { keys: [], text: null };
}

function NestedCardValue({ label, value }: { label: string; value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="border-t border-gray-100 pt-3">
          <p className="text-[11px] font-medium text-gray-500">{humanizeIdentifier(label)}</p>
          <p className="mt-1 text-[12px] text-gray-400">None</p>
        </div>
      );
    }
    return (
      <details className="border-t border-gray-100 pt-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] font-medium text-gray-600">
          <span>{humanizeIdentifier(label)}</span>
          <span className="text-gray-400">{value.length} {value.length === 1 ? "item" : "items"}</span>
        </summary>
        <div className="mt-3"><FriendlyValueContent value={value} /></div>
      </details>
    );
  }
  return (
    <div className="space-y-2 border-t border-gray-100 pt-3">
      <p className="text-[11px] font-medium text-gray-500">{humanizeIdentifier(label)}</p>
      <FriendlyValueContent value={value} />
    </div>
  );
}

function CardItem({ item, index }: { item: Record<string, unknown>; index: number }) {
  const title = cardTitle(item, index);
  const date = cardDate(item);
  const entries = Object.entries(item);
  const scalars = entries.filter(([key, value]) => (
    !isCollection(value) && key !== title.key && !date.keys.includes(key)
  ));
  const collections = entries.filter((entry) => isCollection(entry[1]));
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-xs">
      <h3 className="text-[14px] font-medium text-gray-950">{title.text}</h3>
      {date.text ? <p className="mt-1 text-[12px] text-gray-500">{date.text}</p> : null}
      {scalars.length > 0 ? <div className="mt-4"><DefinitionList entries={scalars} /></div> : null}
      {collections.length > 0 ? (
        <div className="mt-4 space-y-3">
          {collections.map(([key, value]) => <NestedCardValue key={key} label={key} value={value} />)}
        </div>
      ) : null}
    </article>
  );
}

function ObjectTable({ items }: { items: Record<string, unknown>[] }) {
  const columns = [...new Set(items.flatMap((item) => Object.keys(item)))];
  return (
    <div className="overflow-auto rounded-xl border border-gray-200">
      <table className="min-w-full text-left text-[12px]">
        <thead className="bg-gray-50">
          <tr>{columns.map((column) => <th className="px-3 py-2 font-medium text-gray-600" key={column}>{humanizeIdentifier(column)}</th>)}</tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr className="border-t border-gray-100" key={index}>
              {columns.map((column) => <td className="max-w-72 px-3 py-2 text-gray-700" key={column}><ScalarValue value={item[column]} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ObjectArray({ value }: { value: Record<string, unknown>[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? value : value.slice(0, 10);
  const useCards = value.some((item) => Object.keys(item).length > 5 || Object.values(item).some(isCollection));
  return (
    <div className="space-y-3">
      {useCards ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {shown.map((item, index) => <CardItem item={item} index={index} key={index} />)}
        </div>
      ) : <ObjectTable items={shown} />}
      {value.length > 10 ? (
        <button type="button" className="text-[12px] font-medium text-blue-700 hover:text-blue-800" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show first 10" : `Show all ${value.length}`}
        </button>
      ) : null}
    </div>
  );
}

function ScalarArray({ value }: { value: unknown[] }) {
  const shown = value.slice(0, 20);
  return (
    <div className="flex flex-wrap gap-2">
      {shown.map((item, index) => (
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] text-gray-700" key={index}>
          <ScalarValue value={item} />
        </span>
      ))}
      {value.length > 20 ? <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] text-gray-500">+{value.length - 20} more</span> : null}
    </div>
  );
}

function ArrayValue({ value }: { value: unknown[] }) {
  if (value.length === 0) return <span className="text-[13px] text-gray-400">None</span>;
  if (isObjectArray(value)) return <ObjectArray value={value} />;
  if (value.every((item) => !isCollection(item))) return <ScalarArray value={value} />;
  return (
    <div className="space-y-3">
      {value.map((item, index) => <div className="rounded-xl border border-gray-100 p-3" key={index}><FriendlyValueContent value={item} /></div>)}
    </div>
  );
}

function EmptyValue() {
  return <p className="text-[13px] text-gray-400">This run didn&apos;t return anything to show.</p>;
}

function FriendlyValueContent({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <EmptyValue />;
  if (Array.isArray(value)) return <ArrayValue value={value} />;
  if (isPlainObject(value)) return <ObjectValue value={value} />;
  if (isReadableText(value)) return <ReadableText value={value} />;
  return <p className="text-[13px] leading-6 text-gray-700"><ScalarValue value={value} /></p>;
}

export function WorkflowFriendlyValue({ value }: { value: unknown }) {
  return (
    <div data-testid="den-workflow-friendly-value">
      <FriendlyValueContent value={value} />
    </div>
  );
}
