"use client";

import { useRef, useState } from "react";
import { DenButton } from "./ui/button";

type BrowserHandoffFallbackProps = {
  url: string;
  title: string;
  description: string;
  openLabel?: string;
  sanitizeUrl?: (url: string) => string;
  onOpen?: (url: string) => boolean | Promise<boolean>;
};

export type DenBrowserHandoffResult =
  | { ok: true }
  | { ok: false; error: string };

function safeBrowserUrl(value: string) {
  const url = new URL(value, window.location.origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("This browser link is not safe to open.");
  }
  return url.toString();
}

export async function tryOpenDenBrowserHandoff(
  url: string,
  options: {
    sanitizeUrl?: (url: string) => string;
    open?: (url: string) => boolean | Promise<boolean>;
  } = {},
): Promise<DenBrowserHandoffResult> {
  try {
    const safeUrl = (options.sanitizeUrl ?? safeBrowserUrl)(url);
    const opened = options.open
      ? await options.open(safeUrl)
      : window.open(safeUrl, "_blank", "noopener,noreferrer") !== null;
    return opened
      ? { ok: true }
      : { ok: false, error: "The browser blocked the window. Copy or select the full link below." };
  } catch (openError) {
    return {
      ok: false,
      error: openError instanceof Error ? openError.message : "The browser could not be opened.",
    };
  }
}

function legacyCopyUrl(url: string) {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const field = document.createElement("textarea");
  field.value = url;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.focus();
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

export async function copyDenBrowserHandoffUrl(
  url: string,
  options: {
    writeClipboard?: (url: string) => Promise<void>;
    legacyCopy?: (url: string) => boolean;
  } = {},
): Promise<DenBrowserHandoffResult> {
  const writeClipboard = options.writeClipboard ?? (
    typeof navigator !== "undefined"
      ? navigator.clipboard?.writeText?.bind(navigator.clipboard)
      : undefined
  );
  if (writeClipboard) {
    try {
      await writeClipboard(url);
      return { ok: true };
    } catch {
      // Fall through to the selection-based copy path.
    }
  }

  try {
    return (options.legacyCopy ?? legacyCopyUrl)(url)
      ? { ok: true }
      : { ok: false, error: "Automatic copy was blocked." };
  } catch {
    return { ok: false, error: "Automatic copy was blocked." };
  }
}

export function DenBrowserHandoffFallback({
  url,
  title,
  description,
  openLabel = "Open again",
  sanitizeUrl = safeBrowserUrl,
  onOpen,
}: BrowserHandoffFallbackProps) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function selectUrl() {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }

  async function openAgain() {
    const result = await tryOpenDenBrowserHandoff(url, { sanitizeUrl, open: onOpen });
    setStatus(result.ok ? null : result.error);
  }

  async function copyUrl() {
    const result = await copyDenBrowserHandoffUrl(url);
    if (result.ok) {
      setStatus("Link copied.");
      return;
    }

    selectUrl();
    setStatus(`${result.error} The full link is selected; use your keyboard or Edit menu to copy it.`);
  }

  return (
    <div
      data-testid="browser-handoff-fallback"
      className="rounded-2xl border border-amber-200 bg-amber-50 p-4"
    >
      <p className="text-[13px] font-semibold text-amber-950">{title}</p>
      <p className="mt-1 text-[12px] leading-5 text-amber-800">{description}</p>
      <textarea
        ref={fieldRef}
        readOnly
        aria-label={title}
        value={url}
        rows={2}
        onClick={(event) => event.currentTarget.select()}
        onFocus={(event) => event.currentTarget.select()}
        className="mt-3 w-full resize-y rounded-xl border border-amber-200 bg-white px-3 py-2 font-mono text-[11px] leading-5 text-gray-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <DenButton variant="secondary" size="sm" onClick={() => void openAgain()}>
          {openLabel}
        </DenButton>
        <DenButton variant="secondary" size="sm" onClick={() => void copyUrl()}>
          Copy link
        </DenButton>
        {status ? <span role="status" className="text-[12px] text-amber-800">{status}</span> : null}
      </div>
    </div>
  );
}
