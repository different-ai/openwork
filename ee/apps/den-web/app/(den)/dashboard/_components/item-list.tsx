"use client";

import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal, Search } from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { type ButtonSize, type ButtonVariant, buttonVariants } from "../../_components/ui/button";

/** A button-styled client-side link, so moving between steps keeps the page state. */
export function LinkButton({ variant = "secondary", size = "md", className = "", ...rest }: ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return <Link {...rest} className={buttonVariants({ variant, size, className: `gap-2 ${className}` })} />;
}

/**
 * The one list used by My Library and Manage: a white panel of rows with a
 * 32px logo lane, name and description, a status lane, and an action lane.
 */
export function ItemSection({ title, meta, children, testId }: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="flex flex-col gap-2.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[13px] font-medium leading-4 text-gray-500">{title}</h2>
        {meta ? <p className="text-[12px] leading-4 text-gray-500">{meta}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function ItemPanel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white py-1 ${className}`}>
      {children}
    </div>
  );
}

export function ItemRow({
  logo,
  title,
  description,
  status,
  action,
  href,
  testId,
}: {
  logo?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  href?: string;
  testId?: string;
}) {
  const body = (
    <>
      {logo ? <span className="flex shrink-0 items-center">{logo}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-medium leading-5 text-gray-900">{title}</span>
        {description ? <span className="truncate text-[13px] leading-[18px] text-gray-500">{description}</span> : null}
      </span>
    </>
  );
  return (
    <div className="flex items-center gap-3.5 px-5 py-3" data-testid={testId}>
      {href ? (
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-3.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-gray-300">
          {body}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3.5">{body}</span>
      )}
      {status !== undefined ? (
        <span className="hidden w-[220px] shrink-0 truncate text-right text-[12px] leading-4 text-gray-500 sm:block" data-item-status>
          {status}
        </span>
      ) : null}
      {action !== undefined ? <span className="flex w-[72px] shrink-0 justify-end">{action}</span> : null}
    </div>
  );
}

export type ItemMenuEntry = {
  label: string;
  onSelect?: () => void;
  href?: string;
  destructive?: boolean;
  disabled?: boolean;
};

export function ItemMenu({ label, entries, size = "sm" }: { label: string; entries: ItemMenuEntry[]; size?: "sm" | "md" }) {
  if (entries.length === 0) return null;
  const trigger = size === "md"
    ? "flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
    : "flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900";
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={label} className={trigger}>
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="min-w-[160px] rounded-xl border border-gray-200 bg-white p-1 text-[13px] shadow-[0_8px_24px_rgba(15,23,42,0.08)] outline-none">
            {entries.map((entry) => entry.href ? (
              <Menu.Item
                key={entry.label}
                disabled={entry.disabled}
                render={<Link href={entry.href} />}
                className="flex cursor-pointer items-center rounded-lg px-3 py-2 text-gray-700 outline-none data-[highlighted]:bg-gray-50 data-[highlighted]:text-gray-900"
              >
                {entry.label}
              </Menu.Item>
            ) : (
              <Menu.Item
                key={entry.label}
                disabled={entry.disabled}
                onClick={entry.onSelect}
                className={`flex cursor-pointer items-center rounded-lg px-3 py-2 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-gray-50 ${entry.destructive ? "text-red-600" : "text-gray-700 data-[highlighted]:text-gray-900"}`}
              >
                {entry.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Label and value rows under Details. */
export function DetailRows({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <div className="flex flex-col divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-4 px-5 py-3 text-[13px] leading-[18px]">
          <span className="text-gray-500">{row.label}</span>
          <span className="min-w-0 truncate text-right font-medium text-gray-900">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function FilterInput({ value, onChange, size = "sm", className = "" }: {
  value: string;
  onChange: (value: string) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <label className={`flex ${size === "md" ? "h-9" : "h-8"} items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 focus-within:border-gray-400 ${className}`}>
      <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter by name"
        aria-label="Filter by name"
        className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-900 outline-none placeholder:text-gray-400"
      />
    </label>
  );
}
