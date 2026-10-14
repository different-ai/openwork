"use client";

import { ArrowRight } from "lucide-react";

type InstallVisualOs = "macos" | "windows" | "linux";

function AppBadge({ iconUrl, size = "size-14" }: { iconUrl: string | null; size?: string }) {
  if (iconUrl) {
    return (
      // Organization icons may be served by private on-prem hosts that Next/Image cannot proxy.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={iconUrl} alt="" className={`${size} rounded-[22%] object-contain shadow-[0_4px_12px_rgba(16,24,40,0.18)]`} />
    );
  }
  return (
    <img src="/openwork-mark.svg" alt="" className={`${size} rounded-[22%] object-contain shadow-[0_4px_12px_rgba(16,24,40,0.18)]`} />
  );
}

function ApplicationsFolder() {
  return (
    <span className="grid justify-items-center gap-1.5">
      <svg viewBox="0 0 56 44" className="h-11 w-14 drop-shadow-[0_4px_10px_rgba(37,99,235,0.28)]" aria-hidden="true">
        <path d="M4 8c0-2.2 1.8-4 4-4h13l5 6h22c2.2 0 4 1.8 4 4v22c0 2.2-1.8 4-4 4H8c-2.2 0-4-1.8-4-4V8z" fill="#5aa2f5" />
        <path d="M4 14h48v22c0 2.2-1.8 4-4 4H8c-2.2 0-4-1.8-4-4V14z" fill="#7db8f8" />
        <text x="28" y="31" textAnchor="middle" fontSize="13" fontWeight="700" fill="#ffffff" fontFamily="system-ui">A</text>
      </svg>
      <span className="text-[11px] font-medium text-[#344054]">Applications</span>
    </span>
  );
}

function MacDragVisual({ appName, iconUrl }: { appName: string; iconUrl: string | null }) {
  return (
    <div className="w-full max-w-[26rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_10px_30px_-18px_rgba(16,24,40,0.3)]">
      <div className="relative flex h-7 items-center justify-center border-b border-slate-100 bg-[#f7f9fc]">
        <span className="absolute left-2.5 flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="text-[11px] font-medium text-[#3a3a3c]">{appName}</span>
      </div>
      <div className="flex items-center justify-center gap-6 bg-[linear-gradient(180deg,#fbfcfe,#f2f5f9)] px-6 py-7">
        <span className="grid justify-items-center gap-1.5">
          <AppBadge iconUrl={iconUrl} />
          <span className="max-w-[7.5rem] truncate text-[11px] font-medium text-[#344054]">{appName}</span>
        </span>
        <span className="grid justify-items-center gap-0.5 text-[#98a2b3]" aria-hidden="true">
          <ArrowRight className="size-6" strokeWidth={2.2} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em]">drag</span>
        </span>
        <ApplicationsFolder />
      </div>
    </div>
  );
}

function WindowsRunAnywayVisual({ appName }: { appName: string }) {
  return (
    <div className="w-full max-w-[26rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_10px_30px_-18px_rgba(16,24,40,0.3)]">
      <div className="flex h-7 items-center justify-between border-b border-slate-100 bg-[#f7f9fc] px-3">
        <span className="text-[11px] font-medium text-[#3a3a3c]">{appName} Setup</span>
        <span className="flex items-center gap-2 text-[10px] text-[#6b7280]" aria-hidden="true">
          <span>—</span>
          <span>▢</span>
          <span>✕</span>
        </span>
      </div>
      <div className="grid gap-2.5 bg-[#f6f8fb] px-6 py-6">
        <p className="m-0 text-[13px] font-semibold text-[#1c2b44]">Windows protected your PC</p>
        <p className="m-0 text-[11px] leading-4 text-[#475467]">
          Click <span className="font-semibold underline underline-offset-2">More info</span>, then
        </p>
        <span className="grid h-9 w-32 place-items-center rounded-md bg-[#1c2b44] text-[12px] font-semibold text-white">
          Run anyway
        </span>
      </div>
    </div>
  );
}

function LinuxTerminalVisual() {
  return (
    <div className="w-full max-w-[26rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_10px_30px_-18px_rgba(16,24,40,0.3)]">
      <div className="relative flex h-7 items-center justify-center border-b border-slate-100 bg-[#f7f9fc]">
        <span className="text-[11px] font-medium text-[#3a3a3c]">Terminal</span>
      </div>
      <div className="grid gap-1.5 bg-[#101828] px-5 py-5 font-mono text-[11px] leading-5 text-[#d0d5dd]">
        <span>
          <span className="text-[#67e8f9]">$</span> chmod +x openwork-enterprise.AppImage
        </span>
        <span>
          <span className="text-[#67e8f9]">$</span> ./openwork-enterprise.AppImage
        </span>
      </div>
    </div>
  );
}

/** Decorative picture of the install gesture for the detected OS. */
export function InstallVisual({
  os,
  appName,
  iconUrl,
}: {
  os: InstallVisualOs | null;
  appName: string;
  iconUrl: string | null;
}) {
  if (!os) {
    return null;
  }

  return (
    <div aria-hidden="true" data-testid="install-visual" data-visual-os={os}>
      {os === "macos" ? (
        <MacDragVisual appName={appName} iconUrl={iconUrl} />
      ) : os === "windows" ? (
        <WindowsRunAnywayVisual appName={appName} />
      ) : (
        <LinuxTerminalVisual />
      )}
    </div>
  );
}
