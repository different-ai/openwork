"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal, Search } from "lucide-react";
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

/** Placeholder rows the size of ItemRow, for an ItemPanel whose list is loading. */
export function ItemRowsSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} data-testid="item-rows-skeleton" className="flex flex-col divide-y divide-gray-100 motion-safe:animate-pulse">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden className="flex items-center gap-3.5 px-5 py-3">
          <span className="h-8 w-8 shrink-0 rounded-[7px] bg-gray-100" />
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
  onSelect?: () => void | Promise<void>;
  href?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Ask before running onSelect. */
  confirm?: { title: string; description: string; action: string };
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
            <DenButton variant={shown.destructive ? "destructive" : "primary"} loading={busy} onClick={() => void run()}>{shown.confirm?.action}</DenButton>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function ItemMenu({ label, entries, size = "sm" }: { label: string; entries: ItemMenuEntry[]; size?: "sm" | "md" }) {
  const [confirming, setConfirming] = useState<ItemMenuEntry | null>(null);
  if (entries.length === 0) return null;
  const trigger = size === "md"
    ? "flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
    : "flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900";
  return (
    <>
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
