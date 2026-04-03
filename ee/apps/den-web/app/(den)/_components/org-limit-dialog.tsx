"use client";

import { DenButton, buttonVariants } from "./ui/button";

export function OrgLimitDialog({
  open,
  title,
  message,
  detail,
  feedbackHref,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  detail?: string | null;
  feedbackHref: string;
  onClose: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6">
      <div className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]">
        <div className="grid gap-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">Workspace limit</p>
          <div className="grid gap-2">
            <h2 className="text-[24px] font-semibold tracking-[-0.03em] text-gray-950">{title}</h2>
            <p className="text-[15px] leading-7 text-gray-600">{message}</p>
            {detail ? <p className="text-[13px] leading-6 text-gray-500">{detail}</p> : null}
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose}>
            Close
          </DenButton>
          <a href={feedbackHref} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "primary" })}>
            Contact support
          </a>
        </div>
      </div>
    </div>
  );
}
