import type { RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { setStartingModel } from "@/lib/model-choice";
import { Button } from "@/ui/kit";
import { LocalProviders } from "@/ui/local-providers";

/**
 * The step after "Use this Mac": what this Mac already has, one Connect per
 * row, the free model that needs nothing, and Add another. Continue goes on
 * to the first coworker; choosing a model here is what that coworker starts on.
 */
export function LocalModeScreen({
  runtime,
  session,
  onConnectAccount,
  onRuntimeChanged,
  onContinue,
  onBack,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  onConnectAccount: () => void;
  onRuntimeChanged: () => Promise<void>;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <div className="window-shell window-drag flex h-full min-h-[560px] flex-col overflow-y-auto" data-testid="local-mode">
      <header className="flex shrink-0 items-center justify-between px-6 pb-3 pt-5 md:px-8">
        <button type="button" className="window-no-drag rounded-full px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:text-snow" onClick={onBack}>
          ← Back
        </button>
        <button
          type="button"
          className="window-no-drag rounded-full border border-white/9 bg-white/[0.035] px-3.5 py-1.5 text-xs font-medium text-mist transition-colors hover:border-white/16 hover:bg-white/[0.065] hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/45"
          onClick={onConnectAccount}
        >
          Sign in
        </button>
      </header>

      <main className="window-no-drag flex flex-1 justify-center px-6 py-6 md:py-8">
        <section className="w-full max-w-[680px]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">Use this Mac</p>
          <h1 className="mt-2 text-[28px] font-semibold leading-[1.1] tracking-[-0.04em] text-snow md:text-[32px]">AI on this Mac</h1>
          <p className="mt-2 max-w-[520px] text-sm leading-6 text-mist">
            Coworkers can use what you already pay for. Connect what was found, or start with the free model and connect later.
          </p>
          <div className="mt-6">
            <LocalProviders
              runtime={runtime}
              session={session}
              onConnectAccount={onConnectAccount}
              onRuntimeChanged={onRuntimeChanged}
              onStartModel={(modelId) => {
                setStartingModel(modelId);
                onContinue();
              }}
              chooseLabel="Start with this"
            />
          </div>
        </section>
      </main>

      <footer className="window-no-drag flex shrink-0 items-center justify-between gap-4 border-t border-line/60 px-6 py-4 md:px-8">
        <span className="text-[11px] text-mist">You can change all of this later under OpenWork › AI models.</span>
        <Button variant="primary" onClick={onContinue} data-testid="local-mode-continue">Continue</Button>
      </footer>
    </div>
  );
}
