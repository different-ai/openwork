"use client";

import { detectPlatform } from "@openwork/ui/react";
import { useEffect, useState } from "react";

const BACKDROP: Record<"macos" | "windows", string> = {
  macos: "linear-gradient(160deg, #23306f 0%, #46318f 28%, #7d3a9c 55%, #c2508b 78%, #dd8f66 100%)",
  windows: "linear-gradient(160deg, #073a8f 0%, #0f5bc4 55%, #1c74e0 100%)",
};

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 28" className="size-3 shrink-0 fill-[#1d1d1f]" aria-hidden="true">
      <path d="M12.2 6.9c-.9 0-2.4-1.1-4-1-2 .1-3.9 1.2-4.9 3-2.1 3.7-.5 9.1 1.5 12.1 1 1.5 2.2 3.1 3.8 3 1.5-.1 2.1-1 3.9-1 1.8 0 2.4 1 4 .9 1.6 0 2.7-1.5 3.7-2.9 1.2-1.7 1.6-3.3 1.7-3.4 0 0-3.2-1.2-3.2-4.9 0-3 2.5-4.5 2.6-4.6-1.4-2.1-3.6-2.3-4.4-2.4-2-.1-3.7 1.1-4.7 1.2zM15.5 3.8c.8-1 1.4-2.4 1.2-3.8-1.2.1-2.6.8-3.5 1.8-.8.9-1.5 2.3-1.3 3.7 1.4.1 2.8-.7 3.6-1.7z" />
    </svg>
  );
}

function MacMenuBar({ appName }: { appName: string }) {
  return (
    <div className="absolute inset-x-0 top-0 flex h-[26px] items-center gap-3.5 border-b border-black/[0.06] bg-[#fafafc]/70 px-3 text-[10px] text-[#1d1d1f]">
      <AppleIcon />
      <span className="font-bold">{appName} Installer</span>
      <span>File</span>
      <span>Edit</span>
      <span>Help</span>
      <span className="grow" />
      <span>9:41 AM</span>
    </div>
  );
}

function MacDock() {
  return (
    <div className="absolute bottom-2.5 left-1/2 flex h-[3.25rem] -translate-x-1/2 items-center gap-2 rounded-2xl border border-white/40 bg-white/30 px-2.5 shadow-[0_8px_22px_rgba(0,0,0,0.22)]">
      <span className="size-9 rounded-[9px] bg-gradient-to-b from-[#4aa8f0] to-[#2f6fdd]" />
      <span className="size-9 rounded-[9px] bg-gradient-to-b from-white to-[#dfe3ea]" />
      <span className="size-9 rounded-[9px] bg-gradient-to-b from-[#5fd08a] to-[#28a35f]" />
      <span className="size-9 rounded-[9px] bg-gradient-to-b from-[#9aa1ab] to-[#6b727c]" />
      <span className="h-9 w-px bg-white/50" />
      <span className="grid size-9 place-items-center rounded-[9px] bg-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]">
        <span className="size-4 rounded-[5px] bg-[#101828]" />
      </span>
    </div>
  );
}

function WindowsTaskBar() {
  return (
    <div className="absolute inset-x-0 bottom-0 flex h-[26px] items-center gap-3 bg-[#eef2f8]/90 px-3 text-[9px] text-[#1c2b44]">
      <span className="size-3 rounded-[2px] bg-[#1c74e0]" />
      <span className="size-3 rounded-full border border-[#1c2b44]/40" />
      <span className="size-3 rounded-[2px] bg-[#f2b23c]" />
      <span className="size-3 rounded-full bg-[#1c74e0]" />
      <span className="grow" />
      <span>9:41 AM</span>
    </div>
  );
}

/** Decorative preview of the installer window as it appears on this computer. */
export function InstallerPreview({
  appName,
  iconUrl,
  activationLinkHint,
}: {
  appName: string;
  iconUrl: string | null;
  activationLinkHint: string;
}) {
  const [os, setOs] = useState<"macos" | "windows">("macos");

  useEffect(() => {
    let cancelled = false;
    void detectPlatform().then((platform) => {
      if (!cancelled && platform?.os === "windows") setOs("windows");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      data-testid="installer-preview"
      data-preview-os={os}
      className="relative grid h-full min-h-[27rem] place-items-center overflow-hidden rounded-[14px] border border-[#8a93a6] px-3.5 pb-20 pt-14"
      style={{ backgroundImage: BACKDROP[os] }}
    >
      {os === "macos" ? <MacMenuBar appName={appName} /> : null}

      <span className={`absolute left-3 flex items-center gap-1.5 rounded-full border border-slate-500/25 bg-white/90 px-2 py-0.5 text-[9px] font-bold tracking-[0.08em] text-[#344054] shadow-[0_2px_8px_rgba(16,24,40,0.16)] ${os === "macos" ? "top-9" : "top-3"}`}>
        <span className="size-1.5 rounded-full bg-[#667085]" />
        PREVIEW · WHAT YOU&apos;LL SEE ON YOUR COMPUTER
      </span>

      <div className="w-[21rem] max-w-full overflow-hidden rounded-xl border border-[#c7ced8] bg-white shadow-[0_11px_26px_rgba(16,24,40,0.2)]">
        {os === "macos" ? (
          <div className="relative flex h-7 items-center justify-center border-b border-[#e4e8ee] bg-[#f7f9fc]">
            <span className="absolute left-2.5 flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
            </span>
            <span className="text-[11px] font-semibold text-[#3a3a3c]">{appName} Installer</span>
          </div>
        ) : (
          <div className="flex h-7 items-center justify-between border-b border-[#e4e8ee] bg-[#f7f9fc] px-3">
            <span className="text-[11px] font-semibold text-[#3a3a3c]">{appName} Installer</span>
            <span className="flex items-center gap-2 text-[10px] text-[#6b7280]">
              <span>—</span>
              <span>▢</span>
              <span>✕</span>
            </span>
          </div>
        )}

        <div className="grid gap-2 p-3.5">
          <div className="flex items-center gap-1.5">
            {iconUrl ? (
              // Organization icons may be served by private on-prem hosts that Next/Image cannot proxy.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={iconUrl} alt="" className="size-5 rounded-[6px] object-contain" />
            ) : (
              <span className="size-5 rounded-[6px] bg-[#101828]" />
            )}
            <span className="text-xs font-semibold text-[#101828]">{appName}</span>
          </div>
          <p className="m-0 text-[17px] font-semibold tracking-[-0.02em] text-[#101828]">Welcome to {appName}</p>
          <p className="m-0 text-[9px] leading-[1.5] text-[#59616e]">
            Let&apos;s connect this computer to your organization. We&apos;ll open a secure browser window so you can
            sign in and approve access.
          </p>
          <span className="grid h-9 place-items-center rounded-[9px] border border-[#101828]/25 text-[11px] font-medium text-[#667085]">
            Open this in your browser
          </span>
          <div className="grid gap-1.5 rounded-lg border border-[#dce1e8] bg-[#f5f7fa] px-2 py-1.5">
            <span className="text-[8px] font-semibold text-[#60646c]">Browser didn&apos;t open? Copy this activation link:</span>
            <span className="flex items-center gap-2 rounded-md border border-[#d8dce3] bg-white px-1.5 py-1">
              <span className="grow truncate text-[7px] text-[#475467]">{activationLinkHint}</span>
              <span className="text-[8px] font-semibold text-[#101828]">Copy link</span>
            </span>
          </div>
        </div>
      </div>

      {os === "macos" ? <MacDock /> : <WindowsTaskBar />}
    </div>
  );
}
