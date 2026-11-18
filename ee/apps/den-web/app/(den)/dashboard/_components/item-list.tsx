"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu } from "@base-ui/react/menu";
import { ChevronRight, MoreHorizontal, Search } from "lucide-react";
import Link from "next/link";
import { type ComponentProps, type ReactNode, useRef, useState } from "react";
import { type ButtonSize, type ButtonVariant, buttonVariants, DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/** A button-styled client-side link, so moving between steps keeps the page state. */
export function LinkButton({ variant = "secondary", size = "md", className = "", ...rest }: ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return <Link {...rest} className={buttonVariants({ variant, size, className: `gap-2 ${className}` })} />;
}

/**
 * The one list used by My Library and Manage, in the Computers row language:
 * flat rows on the page with a hairline between them, a 32px logo lane, name
 * and description, a status lane, and an action lane. No card around it.
 */
export function ItemSection({ title, meta, children, testId, variant = "default" }: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** "rule": a hairline header over a flat list, as the Library reads. */
  variant?: "default" | "rule";
}) {
  if (variant === "rule") {
    return (
      <section className="flex flex-col" data-testid={testId}>
        <div className="flex items-center justify-between gap-4 border-b border-[var(--den-list-line)] pb-1.5">
          <h2 className="text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">{title}</h2>
          {meta ? <p className="text-[12px] leading-4 text-[var(--dls-text-secondary)]">{meta}</p> : null}
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">{title}</h2>
        {meta ? <p className="text-[12px] leading-4 text-[var(--dls-text-secondary)]">{meta}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function ItemPanel({ children, className = "", variant = "divided" }: {
  children: ReactNode;
  className?: string;
  /** Inset lists use padded, rounded rows instead of edge-to-edge dividers. */
  variant?: "divided" | "inset";
}) {
  return (
    // Both variants read as Computers rows now; "inset" is kept for callers. Rows sit flush on the page:
    // side padding belonged to the card this used to be.
    <div data-variant={variant} className={`flex flex-col border-t border-[var(--den-list-line)] [&>*]:border-b [&>*]:border-[var(--den-list-line)] [&>*]:px-0! ${className}`}>
      {children}
    </div>
  );
}

/** Placeholder rows the size of ItemRow, for an ItemPanel whose list is loading. */
export function ItemRowsSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} data-testid="item-rows-skeleton" className="flex flex-col divide-y divide-[var(--den-list-line)] motion-safe:animate-pulse">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden className="flex min-h-12 items-center gap-3 py-1.5">
          <span className="h-8 w-8 shrink-0 rounded-lg bg-[var(--dls-hover)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex h-5 items-center"><span className="h-3 w-32 rounded bg-gray-100" /></span>
            <span className="flex h-[18px] items-center"><span className="h-2.5 w-56 max-w-full rounded bg-gray-100" /></span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** An ItemSection whose title and rows are still loading. */
export function ItemSectionSkeleton({ label, rows }: { label: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span aria-hidden className="flex h-4 items-center"><span className="h-2.5 w-20 rounded bg-gray-100 motion-safe:animate-pulse" /></span>
      <ItemPanel><ItemRowsSkeleton label={label} rows={rows} /></ItemPanel>
    </div>
  );
}

export function ItemRow({
  logo,
  title,
  description,
  status,
  statusOnNarrow,
  wideAction,
  wrapDescription,
  action,
  href,
  testId,
  comparison,
  compact = false,
}: {
  statusOnNarrow?: boolean;
  wideAction?: boolean;
  wrapDescription?: boolean;
  /** Numeric comparisons stay next to the name instead of using the status lane. */
  comparison?: ReactNode;
  logo?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  href?: string;
  testId?: string;
  /** Compact state lane remains visible in a narrow Library window. */
  compact?: boolean;
}) {
  const body = (
    <>
      {logo ? <span className="flex shrink-0 items-center">{logo}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">{title}</span>
        {statusOnNarrow && status ? <span className="whitespace-nowrap text-[12px] leading-4 text-muted-foreground sm:hidden">{status}</span> : null}
        {description ? <span className={wrapDescription ? "break-words text-[12px] leading-4 text-[var(--dls-text-secondary)]" : "truncate text-[12px] leading-4 text-[var(--dls-text-secondary)]"}>{description}</span> : null}
      </span>
    </>
  );
  return (
    <div className={compact ? "flex min-h-12 items-center gap-3 py-1.5" : statusOnNarrow ? "flex min-h-12 items-center gap-2 py-1.5 sm:gap-3" : "flex min-h-12 items-center gap-3 py-1.5"} data-testid={testId} data-library-integrated-row={compact || undefined}>
      {href ? (
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-gray-300">
          {body}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
      )}
      {comparison}
      {status !== undefined ? (
        <span className={compact ? "w-14 shrink-0 truncate text-right text-[13px] text-[var(--dls-text-secondary)] sm:w-28" : "hidden w-[220px] shrink-0 truncate text-right text-[13px] leading-5 text-[var(--dls-text-secondary)] sm:block"} data-item-status>
          {status}
        </span>
      ) : null}
      {action !== undefined ? <span className={wideAction ? "flex w-[96px] shrink-0 justify-end" : compact ? "flex w-7 shrink-0 justify-end sm:w-[72px]" : "flex w-[72px] shrink-0 justify-end"} data-item-action>{action}</span> : null}
    </div>
  );
}

export type ItemMenuEntry = {
  label: string;
  onSelect?: () => void | Promise<void>;
  href?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Ask before running onSelect. */
  confirm?: { title: string; description: string; action: string };
  testId?: string;
};

/** Remove menu entry that asks first; the same copy everywhere an item can be removed. */
export function removeEntry(name: string, onRemove: () => Promise<void>): ItemMenuEntry {
  return {
    label: "Remove",
    destructive: true,
    onSelect: onRemove,
    confirm: { title: `Remove ${name}?`, description: "Nobody can use it anymore. This cannot be undone.", action: "Remove" },
  };
}

/** Asks before a step that cannot be taken back; stays open with the error if the step fails. */
export function ConfirmDialog({ confirm, destructive = false, onConfirm, onClose }: {
  confirm: { title: string; description: string; action: string } | null;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { reauthDialogOpen } = useOrgDashboard();
  // Keep the last copy while the dialog closes, so it doesn't blank out mid-exit.
  const [shown, setShown] = useState({ confirm, destructive });
  const changed = confirm && (confirm.title !== shown.confirm?.title
    || confirm.description !== shown.confirm?.description
    || confirm.action !== shown.confirm?.action
    || destructive !== shown.destructive);
  if (changed) setShown({ confirm, destructive });

  function close() {
    setError(null);
    onClose();
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Step aside while the identity check is open: it renders below this portal
    // and would be unclickable. The pending action resumes once it resolves.
    <AlertDialog.Root open={Boolean(confirm) && !reauthDialogOpen} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <AlertDialog.Popup initialFocus={cancelRef} aria-busy={busy} data-testid="confirm-dialog" className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none">
          <AlertDialog.Title className="text-[15px] font-medium text-gray-950">{shown.confirm?.title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">{shown.confirm?.description}</AlertDialog.Description>
          {error ? <DenNotice className="mt-4" tone="error" message={error} /> : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close ref={cancelRef} disabled={busy} data-testid="confirm-dialog-cancel" className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
            <DenButton variant={shown.destructive ? "destructive" : "primary"} loading={busy} data-testid="confirm-dialog-action" onClick={() => void run()}>{shown.confirm?.action}</DenButton>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function ItemMenu({ label, entries, size = "sm", testId }: { label: string; entries: ItemMenuEntry[]; size?: "sm" | "md"; testId?: string }) {
  const [confirming, setConfirming] = useState<ItemMenuEntry | null>(null);
  if (entries.length === 0) return null;
  const trigger = size === "md"
    ? "flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
    : "flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900";
  return (
    <>
    <Menu.Root>
      <Menu.Trigger aria-label={label} data-testid={testId} className={trigger}>
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="min-w-[160px] rounded-xl border border-gray-200 bg-white p-1 text-[13px] shadow-[0_8px_24px_rgba(15,23,42,0.08)] outline-none">
            {entries.map((entry) => entry.href ? (
              <Menu.Item
                key={entry.label}
                disabled={entry.disabled}
                data-testid={entry.testId}
                render={<Link href={entry.href} />}
                className="flex cursor-pointer items-center rounded-lg px-3 py-2 text-gray-700 outline-none data-[highlighted]:bg-gray-50 data-[highlighted]:text-gray-900"
              >
                {entry.label}
              </Menu.Item>
            ) : (
              <Menu.Item
                key={entry.label}
                disabled={entry.disabled}
                data-testid={entry.testId}
                onClick={() => (entry.confirm ? setConfirming(entry) : void entry.onSelect?.())}
                className={`flex cursor-pointer items-center rounded-lg px-3 py-2 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-gray-50 ${entry.destructive ? "text-red-600" : "text-gray-700 data-[highlighted]:text-gray-900"}`}
              >
                {entry.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
    <ConfirmDialog
      confirm={confirming?.confirm ?? null}
      destructive={confirming?.destructive}
      onConfirm={() => confirming?.onSelect?.()}
      onClose={() => setConfirming(null)}
    />
    </>
  );
}

/** Label and value rows under Details: flat, a hairline between them, as settings rows are. */
export function DetailRows({ rows }: { rows: { label: string; value: ReactNode; wrap?: boolean }[] }) {
  return (
    <div className="flex flex-col divide-y divide-[var(--den-list-line)] border-y border-[var(--den-list-line)]">
      {rows.map((row) => (
        // A long value reads as a paragraph under its label; a short one sits across from it.
        <div key={row.label} className={`flex min-h-10 gap-x-4 gap-y-0.5 py-2 text-[13px] leading-5 ${row.wrap ? "flex-col" : "items-center justify-between"}`}>
          <span className="shrink-0 text-[var(--dls-text-secondary)]">{row.label}</span>
          <span className={row.wrap ? "min-w-0 max-w-[760px] break-words text-[var(--dls-text-primary)]" : "min-w-0 truncate text-right text-[var(--dls-text-primary)]"}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Disclosures one under another, sharing the hairline between them. */
export function DisclosureGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-col [&>section+section]:border-t-0">{children}</div>;
}

/**
 * One collapsed part of a page: a row that names what is inside, with a
 * chevron on the right that turns as it opens (DESIGN.md P3, S3). The one
 * disclosure every detail page uses. Several in a row go in a `DisclosureGroup`.
 */
export function DisclosureSection({ label, state, open, onToggle, children, testId }: {
  label: string;
  /** What is set, at a glance, beside the chevron. */
  state?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="flex flex-col border-y border-[var(--den-list-line)]">
      <button type="button" aria-expanded={open} onClick={onToggle} data-testid={testId}
        className="flex min-h-12 items-center justify-between gap-4 rounded-sm py-2 text-left text-[13px] font-medium text-[var(--dls-text-primary)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-text-secondary)]">
        {label}
        <span className="flex items-center gap-2 font-normal text-[var(--dls-text-secondary)]">
          {state}
          <ChevronRight className={`h-4 w-4 transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`} strokeWidth={1.5} aria-hidden />
        </span>
      </button>
      {open ? <div className="border-t border-[var(--den-list-line)]">{children}</div> : null}
    </section>
  );
}

export function FilterInput({ value, onChange, size = "sm", className = "", placeholder = "Filter by name", onEnter }: {
  value: string;
  onChange: (value: string) => void;
  size?: "sm" | "md";
  className?: string;
  placeholder?: string;
  /** Enter runs the one action the current value offers. */
  onEnter?: () => void;
}) {
  return (
    <label className={`flex ${size === "md" ? "h-9" : "h-8"} items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 focus-within:border-gray-400 ${className}`}>
      <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onEnter ? (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onEnter();
        } : undefined}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-900 outline-none placeholder:text-gray-400"
      />
    </label>
  );
}
