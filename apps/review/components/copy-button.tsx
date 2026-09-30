"use client";

import { useEffect, useState } from "react";

export function CopyButton({ label, value, link = false }: { label: string; value: string; link?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  return <span className="copy-control">
    <button type="button" className="quiet" onClick={async () => {
      try {
        await navigator.clipboard.writeText(link ? new URL(value, window.location.href).href : value);
        setState("copied");
      } catch { setState("failed"); }
    }}>{label}</button>
    <span role="status" className="copy-status">{state === "copied" ? `${label.replace(/^Copy /, "")} copied` : state === "failed" ? "Could not copy. Select the value manually." : ""}</span>
  </span>;
}
