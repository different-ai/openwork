import type { RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { setStartingModel } from "@/lib/model-choice";
import { Button } from "@/ui/kit";
import { LocalProviders } from "@/ui/local-providers";

/**
 * The step after "Use this Mac": what this Mac already has, one Connect per
 * row, OpenWork's free model (not available until released), and Add another.
 * Continue goes on to the first coworker; choosing a model here is what that
 * coworker starts on.
 */
type LocalModeProps = {
  runtime: RuntimeInfo;
  session: DenSession | null;
  onContinue: () => void;
  onBack: () => void;
} & ({ replay: true } | {
  replay?: false;
  onConnectAccount: () => void;
  onRuntimeChanged: () => Promise<void>;
});

export function LocalModeScreen(props: LocalModeProps) {
  const { runtime, session, onBack, onContinue } = props;
  return (
    <div className="window-shell window-drag flex h-full min-h-[560px] flex-col overflow-y-auto" data-testid="local-mode">
      <header className="window-controls-inset flex shrink-0 items-center justify-between px-6 pb-3 pt-5 md:px-8">
        <button type="button" className="window-no-drag rounded-full px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:text-snow" onClick={onBack}>
          ← Back
        </button>
        {!props.replay ? <button
          type="button"
          className="window-no-drag rounded-full border border-white/9 bg-white/[0.035] px-3.5 py-1.5 text-xs font-medium text-mist transition-colors hover:border-white/16 hover:bg-white/[0.065] hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/45"
          onClick={props.onConnectAccount}
        >
          Sign in
        </button> : <span className="text-xs text-mist">Onboarding replay</span>}
      </header>

      <main className="window-no-drag flex flex-1 justify-center px-6 py-6 md:py-8">
        <section className="w-full max-w-[680px]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">{props.replay ? "Your AI setup" : "Use this Mac"}</p>
          <h1 tabIndex={-1} className="mt-2 text-[28px] font-semibold leading-[1.1] tracking-[-0.04em] text-snow outline-none md:text-[32px]">AI on this Mac</h1>
          <p className="mt-2 max-w-[520px] text-sm leading-6 text-mist">
            {props.replay ? "Your coworkers can use AI from OpenWork or providers on this Mac. This tour keeps your account and model choices exactly as they are." : "Coworkers can use what you already pay for. Connect what was found, or sign in to OpenWork for its models. OpenWork's free model, for people without an account, is coming."}
          </p>
          <div className="mt-6">
            {props.replay ? <div className="divide-y divide-line rounded-2xl border border-line bg-panel/45" data-testid="onboarding-replay-setup">
              <div className="p-5"><h2 className="text-sm font-semibold text-snow">{session ? "Your OpenWork account" : "Local mode"}</h2><p className="mt-1 break-words text-xs leading-5 text-mist">{session ? session.userName || session.userEmail || "Signed in to OpenWork" : "No OpenWork account is connected. An account is optional for local work."}</p></div>
              <div className="p-5"><h2 className="text-sm font-semibold text-snow">{runtime.engineManaged ? "Local AI service is ready" : "Local AI service needs attention"}</h2><p className="mt-1 text-xs leading-5 text-mist">Conversations and local Workers run while Open Coworker is open. Only Cloud responsibilities can run while this Mac is off.</p></div>
              <div className="p-5"><h2 className="text-sm font-semibold text-snow">Your models, your choice</h2><p className="mt-1 text-xs leading-5 text-mist">Manage shared providers in Settings &gt; AI models. Each coworker keeps its own model choice. This replay does not connect or change providers.</p></div>
            </div> : <LocalProviders
              runtime={runtime}
              session={session}
              onConnectAccount={props.onConnectAccount}
              onRuntimeChanged={props.onRuntimeChanged}
              onStartModel={(modelId) => {
                setStartingModel(modelId);
                onContinue();
              }}
              chooseLabel="Start with this"
            />}
          </div>
        </section>
      </main>

      <footer className="window-no-drag flex shrink-0 items-center justify-between gap-4 border-t border-line/60 px-6 py-4 md:px-8">
        <span className="text-[11px] text-mist">{props.replay ? "Your team and conversations are right where you left them." : "You can change all of this later under OpenWork › AI models."}</span>
        <Button variant="primary" onClick={onContinue} data-testid="local-mode-continue">{props.replay ? "Back to my team" : "Continue"}</Button>
      </footer>
    </div>
  );
}
