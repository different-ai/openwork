import { desktopBridge } from "@/app/lib/desktop";
import type { NativeDictationResult } from "@openwork/ui/react";

/** Cancels a pending launch when a composer unmounts or its feature is revoked.
 * A system panel already launched remains under the person's OS controls. */
export async function startNativeDictation(signal: AbortSignal): Promise<NativeDictationResult> {
  const id = crypto.randomUUID();
  const cancel = () => { void desktopBridge.__cancelNativeDictationStart(id).catch(() => {}) };
  if (signal.aborted) return { ok: false, reason: "failed" };
  signal.addEventListener("abort", cancel, { once: true });
  try { return await desktopBridge.__startNativeDictation(id) }
  finally { signal.removeEventListener("abort", cancel) }
}
