/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Loader2 } from "lucide-react";

import {
  copyBrowserHandoffUrl,
  tryOpenBrowserUrl,
  type BrowserHandoffResult,
} from "@/app/lib/browser-handoff";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type BrowserHandoffFallbackProps = {
  url: string;
  title?: string;
  description?: string;
  openLabel?: string;
  className?: string;
  onOpenResult?: (result: BrowserHandoffResult) => void;
};

export function BrowserHandoffFallback({
  url,
  title = "Open this link in your browser",
  description = "If the browser did not open, copy this link or select it below and copy it manually.",
  openLabel = "Open again",
  className,
  onOpenResult,
}: BrowserHandoffFallbackProps) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [opening, setOpening] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "manual">("idle");
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    setCopyStatus("idle");
    setOpenError(null);
  }, [url]);

  const selectUrl = () => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  };

  const openUrl = async () => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    const result = await tryOpenBrowserUrl(url);
    if (!result.ok) setOpenError(result.error);
    setOpening(false);
    onOpenResult?.(result);
  };

  const copyUrl = async () => {
    const result = await copyBrowserHandoffUrl(url);
    if (result.ok) {
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 2_000);
      return;
    }

    setCopyStatus("manual");
    selectUrl();
  };

  return (
    <div
      data-testid="browser-handoff-fallback"
      className={cn("space-y-3 rounded-xl border border-amber-7/40 bg-amber-2/50 p-3 text-left", className)}
    >
      <div className="space-y-1">
        <div className="text-xs font-semibold text-amber-12">{title}</div>
        <div className="text-xs leading-relaxed text-amber-11">{description}</div>
      </div>
      <Textarea
        ref={fieldRef}
        readOnly
        aria-label="Browser link"
        data-testid="browser-handoff-url"
        value={url}
        rows={2}
        onClick={(event) => event.currentTarget.select()}
        onFocus={(event) => event.currentTarget.select()}
        className="max-h-28 resize-y font-mono text-[11px] leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void openUrl()} disabled={opening}>
          {opening ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
          {openLabel}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void copyUrl()}>
          <Copy className="size-3.5" />
          {copyStatus === "copied" ? "Copied" : "Copy link"}
        </Button>
        {copyStatus === "manual" ? (
          <span role="status" className="text-xs text-amber-11">
            Copy was blocked. The full link is selected; use your keyboard or Edit menu to copy it.
          </span>
        ) : null}
        {openError ? (
          <span role="status" className="text-xs text-amber-11">
            {openError} Use the link above instead.
          </span>
        ) : null}
      </div>
    </div>
  );
}
