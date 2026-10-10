"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import {
  PERMISSION_AREAS,
  PERMISSION_KEYS,
  getPermissionDefinition,
  type PermissionAreaKey,
  type PermissionKey,
} from "@openwork/types/den/permissions";
import { buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenSwitch } from "../../_components/ui/switch";
import { getOrgAccessFlags, orgFeatureEnabled, type DenOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { FilterInput } from "./item-list";
import type { PermissionStatus } from "./permissions-data";

const ENTERPRISE_CONTACT_URL =
  process.env.NEXT_PUBLIC_ENTERPRISE_CONTACT_URL || "https://openworklabs.com/enterprise#book";

export type PermissionsAccess =
  | { state: "checking" | "error" | "feature_off" }
  | {
    state: "ready";
    orgId: string;
    orgSlug: string | null;
    access: DenOrgAccessFlags;
    currentMemberId: string;
    /** Keys the signed-in member holds; the owner holds every key. */
    held: ReadonlySet<string>;
  };

/** Whether the Permissions screens can load, from GET /v1/org. */
export function usePermissionsAccess(): PermissionsAccess {
  const { orgId, orgSlug, orgContext, orgBusy, orgError } = useOrgDashboard();
  if (orgError && !orgBusy) return { state: "error" };
  if (orgBusy || !orgContext || !orgId || orgContext.organization.id !== orgId) return { state: "checking" };
  if (!orgFeatureEnabled(orgContext, "permissions")) return { state: "feature_off" };
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  const held = new Set<string>(access.isOwner ? PERMISSION_KEYS : orgContext.currentMember.permissions ?? []);
  return { state: "ready", orgId, orgSlug, access, currentMemberId: orgContext.currentMember.id, held };
}

export function PermissionsPage({ title, back, action, caption, children, testId }: {
  title: ReactNode;
  back?: { href: string; label: string };
  action?: ReactNode;
  caption?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-4 py-6 text-[13px] sm:px-6 md:px-8" data-testid={testId}>
      {back ? (
        <Link href={back.href} className="inline-flex w-fit items-center gap-1.5 rounded text-[13px] text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400">
          <ArrowLeft className="size-4" aria-hidden="true" strokeWidth={1.5} />
          {back.label}
        </Link>
      ) : null}
      <DenPageHeader size="compact" title={title} action={action} caption={caption ? <span className="text-gray-500">{caption}</span> : undefined} />
      {children}
    </section>
  );
}

/** Feature off: the reason and who can change it (DESIGN.md P4, C5). */
export function PermissionsFeatureOff() {
  return (
    <div className="flex flex-col items-start gap-3" data-testid="permissions-feature-off">
      <DenNotice
        tone="neutral"
        icon={LockKeyhole}
        message="Permissions is an Enterprise feature. Contact us to turn it on for your organization."
        className="w-full"
      />
      <a href={ENTERPRISE_CONTACT_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
        Contact us
      </a>
    </div>
  );
}

/** The page body for states that come before data: checking, error, feature off. */
export function PermissionsAccessState({ access }: { access: PermissionsAccess }) {
  if (access.state === "feature_off") return <PermissionsFeatureOff />;
  if (access.state === "error") return <DenNotice tone="error" message="Couldn't check your access to Permissions. Reload the page to try again." />;
  return <PermissionRowsSkeleton />;
}

export function PermissionRowsSkeleton({ rows = 6, label = "Loading permissions" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col" data-testid="permissions-loading">
      <DenSkeleton className="mb-2 h-3 w-32" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-11 items-center gap-3 border-b border-gray-100 py-2" aria-hidden="true">
          <DenSkeleton className="h-3 w-56 max-w-full" />
          <span className="flex-1" />
          <DenSkeleton className="h-5 w-9 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeTimeLabel(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const seconds = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "Just now";
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relativeFormat.format(Math.round(seconds / 3600), "hour");
  if (abs < 86_400 * 30) return relativeFormat.format(Math.round(seconds / 86_400), "day");
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function RelativeTime({ value }: { value: string }) {
  const exact = new Date(value).toLocaleString();
  return <time dateTime={value} title={exact} className="shrink-0 text-[12px] text-gray-500">{relativeTimeLabel(value)}</time>;
}

export type PermissionArea = { key: PermissionAreaKey; label: string; keys: PermissionKey[] };

/** Catalog keys grouped by area, in catalog order. Only keys in `include` when given. */
export function permissionAreas(include?: ReadonlySet<string>): PermissionArea[] {
  const areas = new Map<PermissionAreaKey, PermissionKey[]>();
  for (const key of PERMISSION_KEYS) {
    if (include && !include.has(key)) continue;
    const area = getPermissionDefinition(key).area;
    areas.set(area, [...(areas.get(area) ?? []), key]);
  }
  return [...areas.entries()].map(([key, keys]) => ({ key, label: PERMISSION_AREAS[key].label, keys }));
}

export function PermissionAreaSection({ label, meta, children, testId }: { label: string; meta?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col" data-testid={testId} aria-label={label}>
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 pb-1.5">
        <h2 className="text-[12px] font-medium leading-4 text-gray-700">{label}</h2>
        {meta ? <div className="text-[12px] leading-4 text-gray-500">{meta}</div> : null}
      </div>
      <div className="flex flex-col [&>*]:border-b [&>*]:border-gray-100">{children}</div>
    </section>
  );
}

/** The permission's description, shown under its title. */
export function PermissionDescription({ permissionKey, id }: { permissionKey: PermissionKey; id?: string }) {
  const definition = getPermissionDefinition(permissionKey);
  if (!definition.description) return null;
  return <p id={id} className="mt-0.5 text-[12px] leading-4 text-gray-500">{definition.description}</p>;
}

/** Whether a permission's title or description contains the search text. */
export function permissionMatchesSearch(key: PermissionKey, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const definition = getPermissionDefinition(key);
  return definition.label.toLowerCase().includes(needle) || (definition.description ?? "").toLowerCase().includes(needle);
}

/** Compact filter over permission titles and descriptions, using the shared list control. */
export function PermissionSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="w-[240px] max-w-full" data-testid="permission-search">
      <FilterInput value={value} onChange={onChange} placeholder="Filter permissions" />
    </div>
  );
}

export type PermissionEditorRow = {
  key: PermissionKey;
  /** Saved status. */
  status: PermissionStatus;
  /** Status in the editor, including unsaved changes. */
  draft: PermissionStatus;
  /** Why this toggle can't be changed, or null when it can. */
  lockedReason: string | null;
};

/**
 * Permissions grouped by area with one labelled toggle each, a search over
 * titles and descriptions, and an "Allow all" toggle per area. Locked rows stay
 * visible, on or off, with the reason (DESIGN.md P4, C5).
 */
export function PermissionEditor({ rows, onToggle, readOnlyReasonId, beforeList }: {
  rows: PermissionEditorRow[];
  onToggle: (key: PermissionKey, next: PermissionStatus) => void;
  /** When set, every toggle is read only and described by this element (the page's read-only notice). */
  readOnlyReasonId?: string;
  /** Rendered between the search field and the list, e.g. a read-only notice. */
  beforeList?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const visible = new Set(rows.filter((row) => permissionMatchesSearch(row.key, search)).map((row) => row.key));
  const areas = permissionAreas(visible);
  const readOnly = readOnlyReasonId !== undefined;
  return (
    <div className="flex flex-col gap-4" data-testid="permission-editor">
      <PermissionSearch value={search} onChange={setSearch} />
      {beforeList}
      {areas.length === 0 ? (
        <p className="py-3 text-[13px] text-gray-500" data-testid="permission-search-empty">No permissions match “{search.trim()}”.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {areas.map((area) => {
            const areaRows = area.keys.flatMap((key) => {
              const row = byKey.get(key);
              return row ? [row] : [];
            });
            const totalInArea = rows.filter((row) => getPermissionDefinition(row.key).area === area.key);
            const allowed = totalInArea.filter((row) => row.draft === "allow").length;
            // "Allow all" acts on the rows shown (all of them unless a search is active) that can change.
            const toggleable = readOnly ? [] : areaRows.filter((row) => row.lockedReason === null);
            // With nothing to change (locked or read only), reflect whether everything shown is allowed.
            const allOn = (toggleable.length > 0 ? toggleable : areaRows).every((row) => row.draft === "allow");
            const setAll = (next: boolean) => {
              for (const row of toggleable) {
                const status: PermissionStatus = next ? "allow" : "deny";
                if (row.draft !== status) onToggle(row.key, status);
              }
            };
            return (
              <PermissionAreaSection
                key={area.key}
                label={area.label}
                meta={(
                  <span className="flex items-center gap-3">
                    <span>{`${allowed} of ${totalInArea.length} allowed`}</span>
                    <span className="flex items-center gap-2 text-gray-700">
                      <span aria-hidden="true">Allow all</span>
                      <DenSwitch
                        size="sm"
                        checked={allOn}
                        disabled={toggleable.length === 0}
                        onChange={setAll}
                        aria-label={`Allow all ${area.label} permissions`}
                        testId={`permission-area-allow-all-${area.key}`}
                      />
                    </span>
                  </span>
                )}
                testId={`permission-area-${area.key}`}
              >
                {areaRows.map((row) => <PermissionEditorRowView key={row.key} row={row} onToggle={onToggle} readOnlyReasonId={readOnlyReasonId} />)}
              </PermissionAreaSection>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PermissionEditorRowView({ row, onToggle, readOnlyReasonId }: {
  row: PermissionEditorRow;
  onToggle: (key: PermissionKey, next: PermissionStatus) => void;
  readOnlyReasonId?: string;
}) {
  const definition = getPermissionDefinition(row.key);
  const baseId = `permission-${row.key.replace(/[^a-z0-9_]/g, "-")}`;
  const reasonId = `${baseId}-reason`;
  const descriptionId = `${baseId}-description`;
  const changed = row.draft !== row.status;
  const locked = row.lockedReason !== null;
  const disabled = locked || readOnlyReasonId !== undefined;
  const describedBy = [definition.description ? descriptionId : null, locked ? reasonId : readOnlyReasonId ?? null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex min-h-11 items-center gap-3 py-2" data-testid="permission-row" data-permission-key={row.key} data-status={row.draft} data-locked={disabled ? "true" : "false"}>
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] font-medium ${disabled ? "text-gray-500" : "text-gray-900"}`}>{definition.label}</p>
        <PermissionDescription permissionKey={row.key} id={descriptionId} />
      </div>
      {changed ? <span className="shrink-0 text-[12px] font-medium text-gray-700">Not saved</span> : null}
      {locked ? (
        <span id={reasonId} className="inline-flex shrink-0 items-center gap-1 text-[12px] text-gray-500">
          <LockKeyhole className="size-3.5" aria-hidden="true" strokeWidth={1.5} />
          {row.lockedReason}
        </span>
      ) : null}
      <DenSwitch
        size="sm"
        checked={row.draft === "allow"}
        disabled={disabled}
        onChange={(next) => onToggle(row.key, next ? "allow" : "deny")}
        aria-label={definition.label}
        aria-describedby={describedBy}
      />
    </div>
  );
}

/** "Allowed" / "Not allowed", with a lock when it can't be turned off. */
export function PermissionStatusLabel({ status, locked }: { status: PermissionStatus; locked?: boolean }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[12px] ${status === "allow" ? "font-medium text-gray-900" : "text-gray-500"}`} data-status={status}>
      {locked ? <LockKeyhole className="size-3.5" aria-hidden="true" strokeWidth={1.5} /> : null}
      {status === "allow" ? "Allowed" : "Not allowed"}
      {locked ? <span className="sr-only">, always on</span> : null}
    </span>
  );
}
