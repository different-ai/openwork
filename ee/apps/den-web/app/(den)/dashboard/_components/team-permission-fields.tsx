"use client";

import { useId, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

export function TeamPermissionGroup({ title, description, status, icon: Icon, children, defaultOpen = false }: {
  title: string;
  description: string;
  status: string;
  icon: LucideIcon;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return <details open={defaultOpen || undefined} className="group rounded-xl border border-gray-200 bg-white">
    <summary className="grid cursor-pointer list-none grid-cols-[16px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 p-4 sm:grid-cols-[16px_minmax(0,1fr)_auto] [&::-webkit-details-marker]:hidden">
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-gray-900">{title}</span><span className="mt-1 block text-xs leading-5 text-gray-500">{description}</span></span>
      <span className="col-start-2 flex items-center gap-2 sm:col-start-3 sm:row-start-1"><span className="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">{status}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-gray-500 group-open:rotate-180" /></span>
    </summary>
    <div className="px-4 pb-4 sm:pl-11">{children}</div>
  </details>;
}

export function TeamPermissionSelect({ label, allowed, onChange }: { label: string; allowed: boolean; onChange: (allowed: boolean) => void }) {
  const id = useId();
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 py-3">
    <label htmlFor={id} className="text-sm text-gray-800">{label}</label>
    <select id={id} value={allowed ? "allow" : "deny"} onChange={(event) => onChange(event.target.value === "allow")} className="max-w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800">
      <option value="allow">Allowed</option><option value="deny">Blocked</option>
    </select>
  </div>;
}
