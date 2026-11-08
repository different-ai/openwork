"use client";

import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenCheckbox } from "../../_components/ui/checkbox";

export function ConnectorCallbackUpdate({ callbackUrl, confirmed, onConfirmedChange }: {
  callbackUrl?: string | null;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex flex-col gap-3" data-testid="connector-callback-update">
      <p className="text-[13px] text-gray-600">The deployment domain changed. Update the allowed callback URL in your provider’s OAuth app, then confirm below and reconnect.</p>
      {callbackUrl ? <div className="flex min-h-10 items-center gap-3 border-b border-gray-100 py-1.5">
        <span className="shrink-0 text-[12px] font-medium text-gray-700">Callback URL</span>
        <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-gray-600">{callbackUrl}</code>
        <DenButton type="button" size="xs" variant="secondary" aria-label="Copy callback URL" onClick={() => {
          void navigator.clipboard.writeText(callbackUrl).then(() => setCopyStatus("copied")).catch(() => setCopyStatus("failed"));
        }}>{copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}</DenButton>
      </div> : null}
      <label className="flex items-center gap-2 text-[13px] text-gray-700">
        <DenCheckbox name="callbackUpdateConfirmed" checked={confirmed} onCheckedChange={onConfirmedChange} />
        I updated the callback URL in the provider
      </label>
    </div>
  );
}
