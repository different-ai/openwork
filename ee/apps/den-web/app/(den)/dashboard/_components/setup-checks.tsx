"use client";

import { Loader2, X } from "lucide-react";
import type { ReactNode } from "react";

export type SetupCheckStatus = "waiting" | "running" | "current" | "done" | "failed";

export type SetupCheck = {
  id: string;
  title: string;
  description: string;
  status: SetupCheckStatus;
  action?: ReactNode;
};

function CheckIcon({ status }: { status: SetupCheckStatus }) {
  if (status === "done") {
    return (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden className="shrink-0">
        <circle cx="10" cy="10" r="10" fill="#3F9A6B" />
        <path d="M6 10.2l2.6 2.6L14 7.4" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "running") return <Loader2 className="h-[18px] w-[18px] shrink-0 animate-spin text-gray-400" aria-hidden />;
  if (status === "failed") {
    return (
      <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-red-600 text-white">
        <X className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "current") {
    return (
      <span aria-hidden className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-gray-900">
        <span className="h-2 w-2 rounded-full bg-gray-900" />
      </span>
    );
  }
  return <span aria-hidden className="h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px] border-gray-200" />;
}

/** The one checks list: each check fills in as OpenWork confirms it. */
export function SetupChecks({ checks }: { checks: SetupCheck[] }) {
  return (
    <ol className="flex flex-col divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white" data-testid="setup-checks">
      {checks.map((check) => (
        <li
          key={check.id}
          data-testid={`setup-check-${check.id}`}
          data-status={check.status}
          className="flex items-center gap-3.5 px-5 py-4"
        >
          <CheckIcon status={check.status} />
          <div className="min-w-0 flex-1">
            <p className={`text-[14px] font-medium leading-5 ${check.status === "waiting" ? "text-gray-400" : "text-gray-900"}`}>{check.title}</p>
            <p className={`text-[13px] leading-[18px] ${check.status === "failed" ? "text-red-600" : check.status === "waiting" ? "text-gray-400" : "text-gray-500"}`}>
              {check.description}
            </p>
          </div>
          {check.action ? <div className="shrink-0">{check.action}</div> : null}
        </li>
      ))}
    </ol>
  );
}
