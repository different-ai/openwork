import { Button, StatusDot } from "@/ui/kit";
import { CoworkerMark } from "@/ui/brand";

export function OnboardingWelcome({
  onConnect,
  onContinueLocally,
}: {
  onConnect: () => void;
  onContinueLocally: () => void;
}) {
  return (
    <div className="window-shell window-drag flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="window-no-drag w-full max-w-3xl rounded-[30px] border border-line bg-ink/90 p-7 md:p-9">
        <div className="max-w-xl">
          <div className="mb-6 flex items-center gap-3">
            <CoworkerMark animated label="Open Coworker" size={54} />
            <div>
              <p className="text-sm font-semibold tracking-[-0.02em] text-snow">Open Coworker</p>
              <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.17em] text-mist">Powered by OpenWork</p>
            </div>
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-spark">Welcome to Open Coworker</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] text-snow">
            Give recurring work a teammate.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-mist">
            Each coworker gets a durable identity, inspectable memory, a native OpenWork workspace, and a model you control.
          </p>
        </div>

        <div className="mt-7 grid gap-3 md:grid-cols-2">
          <button
            type="button"
            className="rounded-2xl border border-spark/35 bg-spark/8 p-5 text-left transition-colors hover:bg-spark/12"
            onClick={onConnect}
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-snow">
              <StatusDot tone="spark" />
              Connect OpenWork Cloud
            </span>
            <span className="mt-2 block text-xs leading-relaxed text-mist">
              Recommended for always-on responsibilities, organization settings, and work that continues when this Mac is offline.
            </span>
            <span className="mt-4 block text-xs font-semibold text-spark">Sign in and continue →</span>
          </button>

          <button
            type="button"
            className="rounded-2xl border border-line bg-panel/60 p-5 text-left transition-colors hover:bg-panel"
            onClick={onContinueLocally}
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-snow">
              <StatusDot tone="mint" />
              Start locally
            </span>
            <span className="mt-2 block text-xs leading-relaxed text-mist">
              No account required. Coworkers and local responsibilities run through the embedded OpenWork engine while this app is available.
            </span>
            <span className="mt-4 block text-xs font-semibold text-snow">Continue on this Mac →</span>
          </button>
        </div>

        <div className="mt-7 flex items-center justify-between gap-4 border-t border-line pt-5">
          <p className="text-[10px] uppercase tracking-[0.13em] text-mist/75">Local-first · inspectable files · OpenWork native</p>
          <Button variant="ghost" className="text-xs" onClick={onContinueLocally}>Skip sign-in</Button>
        </div>
      </div>
    </div>
  );
}
