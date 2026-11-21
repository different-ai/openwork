import { desktopBridge } from "@/app/lib/desktop";
import type { NativeDictationResult } from "@openwork/ui/react";

export async function startNativeDictation(signal: AbortSignal): Promise<NativeDictationResult> {
  const id = crypto.randomUUID();
  const cancel = () => { void desktopBridge.__cancelNativeDictationStart(id).catch(() => {}) };
  if (signal.aborted) return { ok: false, reason: "failed" };
  signal.addEventListener("abort", cancel, { once: true });
  try { return await desktopBridge.__startNativeDictation(id) }
  finally { signal.removeEventListener("abort", cancel) }
}
