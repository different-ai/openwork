import { useRef, useState } from "react";
import { coworkerBridge } from "@/lib/bridge";
import { Button, ErrorNote } from "@/ui/kit";

export function FreshStartSettings({ onReplay, onFactoryReset }: { onReplay: () => void; onFactoryReset: () => void }) {
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState("");
  const restoringRef = useRef(false);

  async function restoreDefaults() {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(true);
    setRestored(false);
    setError("");
    try {
      await coworkerBridge.maintenance.restoreDefaults();
      setRestored(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      restoringRef.current = false;
      setRestoring(false);
    }
  }

  return <section data-testid="fresh-start-settings">
    <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">A little refresh, or a clean slate.</h2>
    <p className="mt-2 text-sm leading-relaxed text-mist">Choose just the fresh start you need.</p>
    <div className="mt-6 divide-y divide-line rounded-2xl border border-line bg-panel/45">
      <div className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="min-w-[180px] flex-1"><h3 className="text-sm font-semibold text-snow">Replay onboarding</h3><p className="mt-1 text-xs leading-5 text-mist">Revisit the welcome and AI setup tour. Return to this team without changing your account or adding anyone.</p></div>
        <Button type="button" onClick={onReplay} disabled={restoring} data-testid="fresh-start-replay">Replay onboarding</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="min-w-[180px] flex-1"><h3 className="text-sm font-semibold text-snow">Restore app defaults</h3><p className="mt-1 text-xs leading-5 text-mist">Reset app-wide scheduling limits and progress preferences only. Keep your coworkers, accounts and history.</p></div>
        <Button type="button" onClick={() => void restoreDefaults()} disabled={restoring} data-testid="fresh-start-defaults">{restoring ? "Restoring..." : "Restore app defaults"}</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="min-w-[180px] flex-1"><h3 className="text-sm font-semibold text-snow">Factory reset</h3><p className="mt-1 text-xs leading-5 text-mist">Start over on this Mac, with a private recovery copy. Review everything on the next page before erasing.</p></div>
        <Button type="button" variant="danger" onClick={onFactoryReset} disabled={restoring} data-testid="fresh-start-factory-reset">Factory reset</Button>
      </div>
    </div>
    {restored ? <p role="status" className="mt-4 text-xs leading-5 text-mist">App defaults restored. Your team, accounts and history are unchanged.</p> : null}
    {error ? <div role="alert" className="mt-4"><ErrorNote>{error}</ErrorNote></div> : null}
  </section>;
}
