import { useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { freshStartLines, resetConfirmation } from "@/lib/fresh-start";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, ChevronIcon, ErrorNote } from "@/ui/kit";
import "./fresh-start.css";

type ResetPreview = Awaited<ReturnType<typeof coworkerBridge.maintenance.preview>>;
type ResetFace = Pick<CoworkerSummary, "slug" | "name" | "roleId" | "avatarColor" | "avatarGlasses">;
const MASCOT: ResetFace = { slug: "fresh-start-mascot", name: "Open Coworker", roleId: "", avatarColor: "blue", avatarGlasses: "round" };

export function FactoryResetScreen({ coworkers, onBack }: { coworkers: CoworkerSummary[]; onBack: () => void }) {
  const [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [phase, setPhase] = useState<"ready" | "resetting" | "restarting" | "failed">("ready");
  const [error, setError] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [reaction, setReaction] = useState(0);
  const operationRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const { progress, confirmed } = resetConfirmation(confirmation);
  const busy = phase === "resetting" || phase === "restarting";
  const faces = coworkers.length ? coworkers.slice(0, 3) : [MASCOT];
  const lines = freshStartLines(faces);

  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError("");
    void coworkerBridge.maintenance.preview().then((result) => {
      if (!Number.isSafeInteger(result.coworkerCount) || result.coworkerCount < 0
        || !Number.isSafeInteger(result.historyCount) || result.historyCount < 0 || !result.backupDirectory.trim()) {
        throw new Error("The app could not verify the reset scope and recovery location.");
      }
      if (!cancelled) setPreview(result);
    }).catch((cause) => {
      if (!cancelled) setPreviewError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [previewAttempt]);
  useEffect(() => {
    if (phase !== "ready") statusRef.current?.focus({ preventScroll: true });
  }, [phase]);

  function back() {
    if (!operationRef.current) onBack();
  }

  async function erase() {
    // Guard the event itself, including two clicks before React has rendered the disabled button.
    if (operationRef.current || !preview || !resetConfirmation(confirmation).confirmed) return;
    operationRef.current = true;
    setPhase("resetting");
    setError("");
    try {
      const result = await coworkerBridge.maintenance.factoryReset({ confirmation });
      setBackupPath(result.backupDirectory);
      setPhase("restarting");
      // Native owns relaunch. Keep this screen locked until that really happens.
    } catch (cause) {
      operationRef.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    }
  }

  return (
    <div className="fresh-start-page window-shell" data-testid="factory-reset-screen" data-phase={phase} onKeyDownCapture={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      back();
    }}>
      <header className="fresh-start-header window-drag window-controls-inset">
        <Button type="button" variant="ghost" className="window-no-drag flex items-center gap-1.5" onClick={back} disabled={busy}>
          <ChevronIcon direction="left" /> Back to Settings
        </Button>
        <span className="fresh-start-header-label">Open Coworker / Fresh start</span>
      </header>

      <main className="fresh-start-main" aria-labelledby="fresh-start-title">
        <div className="fresh-start-intro">
          <p className="fresh-start-eyebrow">Factory reset</p>
          <h1 id="fresh-start-title" ref={headingRef} tabIndex={-1}>A clean slate.<br /><span>A tiny team huddle.</span></h1>
          <p>{coworkers.length ? "Start over on this Mac. Your team has a few last-minute notes." : "A new beginning for Open Coworker on this Mac. Glasses included."}</p>
        </div>

        <section className="fresh-start-team" aria-label={coworkers.length ? "Your coworkers" : "Open Coworker mascot"} data-count={faces.length} data-progress={progress}>
          <div className="fresh-start-cast">
            {faces.map((coworker, index) => (
              <div key={coworker.slug} className="fresh-start-character" data-color={coworker.avatarColor}>
                <p className="fresh-start-bubble">{coworkers.length ? lines[index] : "New notebook? I'll bring the glasses!"}</p>
                <div className="fresh-start-face-stage">
                  <div className="fresh-start-face" style={{ filter: `grayscale(${progress})` }}>
                    <CoworkerAvatar name={coworker.name} identity={coworker.slug} color={coworker.avatarColor} glasses={coworker.avatarGlasses} size={136} motion="attentive" animated={!busy} />
                  </div>
                  <svg key={reaction} className={`fresh-start-doodles ${reaction > 0 && progress > 0 ? "is-reacting" : ""}`} viewBox="0 0 200 166" fill="none" aria-hidden="true">
                    <g className="fresh-start-droplet" style={{ opacity: progress > 0 ? 1 : 0 }}>
                      <path className="fresh-start-sweat" d="M164 34c-2 5-10 14-10 20a10 10 0 0 0 20 0c0-6-8-15-10-20Z" />
                      <path className="fresh-start-sweat-depth" d="M171 51c2 7-2 11-7 11" />
                      <path className="fresh-start-sweat-shine" d="M161 47c-2 3-3 5-3 7" />
                      <circle className="fresh-start-sweat-spark" cx="160" cy="58" r="1.1" />
                    </g>
                    <g className="fresh-start-surprise" style={{ opacity: progress >= 1 / 3 ? 0.8 + progress * 0.2 : 0 }}>
                      <path d={index % 2 === 0 ? "M30 38q-8 5-2 11t-2 11M19 34q-8 5-2 11t-2 11" : "M171 89q8 5 2 11t2 11M184 85q8 5 2 11t2 11"} />
                      <path d="m50 20-4-9m13 7 1-8" />
                    </g>
                  </svg>
                </div>
                <p className="fresh-start-name">{coworker.name}</p>
              </div>
            ))}
          </div>
          {coworkers.length > 3 ? <p className="fresh-start-overflow">+{coworkers.length - 3} more on your team</p> : null}
        </section>

        <div className="fresh-start-decision">
          <section className="fresh-start-scope" aria-labelledby="fresh-start-scope-title">
            <h2 id="fresh-start-scope-title">What starts fresh</h2>
            <p>Your local coworkers, their memory, documents, discussions, Workers and schedules. Also this app's settings, sign-ins and browser data.</p>
            {preview ? <p className="fresh-start-counts" data-testid="factory-reset-counts"><strong>{preview.coworkerCount}</strong> coworker{preview.coworkerCount === 1 ? "" : "s"}<span aria-hidden="true"> / </span><strong>{preview.historyCount}</strong> history session{preview.historyCount === 1 ? "" : "s"}</p> : null}
            <p className="fresh-start-preserved">Other OpenWork profiles, external files and Cloud data stay as they are. Cloud schedules are not cancelled.</p>
            <div className="fresh-start-recovery">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4 3 7 7.5 9.5 4.5-2.5 7.5-5.5 7.5-9.5V6L12 3Z" /><path d="m8.5 11.8 2.3 2.3 4.7-4.7" /></svg>
              <div>
                <h3>A private recovery copy, always</h3>
                <p>Saved before anything is erased. Keep it safe; it contains private app data. Recovery is manual, not a one-click undo.</p>
                {preview ? <><span className="fresh-start-path-label">Recovery folder</span><code data-testid="factory-reset-backup-directory">{preview.backupDirectory}</code></> : null}
              </div>
            </div>
          </section>

          <section className="fresh-start-confirm" aria-labelledby="fresh-start-confirm-title">
            <h2 id="fresh-start-confirm-title">Ready for a fresh start?</h2>
            <label htmlFor="fresh-start-confirmation">Type <strong>DELETE</strong> to unlock Erase &amp; restart.</label>
            <div className="fresh-start-input-wrap">
              <input id="fresh-start-confirmation" data-testid="factory-reset-confirmation" type="text" value={confirmation} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} disabled={busy} aria-describedby="fresh-start-input-hint" onChange={(event) => {
                const value = event.target.value;
                if (resetConfirmation(value).progress > progress) setReaction((current) => current + 1);
                setConfirmation(value);
              }} />
              <span className="fresh-start-input-marker" aria-hidden="true">{confirmed ? "Ready" : "DELETE"}</span>
            </div>
            <p id="fresh-start-input-hint" className="fresh-start-input-hint">Exact capitals, no spaces. Typing never erases anything.</p>

            {!preview && !previewError ? <p role="status" className="fresh-start-checking">Checking reset scope and recovery location...</p> : null}
            {previewError ? <div className="fresh-start-feedback" role="alert"><ErrorNote>{previewError}</ErrorNote><p>Erase is unavailable until these checks succeed.</p><Button type="button" onClick={() => setPreviewAttempt((current) => current + 1)}>Retry checks</Button></div> : null}
            {phase !== "ready" ? <div ref={statusRef} tabIndex={-1} role={phase === "failed" ? "alert" : "status"} className="fresh-start-feedback" data-testid="factory-reset-status">
              {phase === "failed" ? <><h3>Fresh start needs attention</h3><ErrorNote>{error}</ErrorNote><p>Nothing will retry automatically. Follow the details above before trying again.</p></> : phase === "resetting" ? <><h3>Getting ready for a fresh start...</h3><p>Stopping work safely. Nothing is erased until a recovery copy is ready.</p></> : <><h3>Closing this window for a fresh start...</h3><p>The app will save a recovery copy, reset, and reopen. Your recovery folder:</p><code>{backupPath}</code></>}
            </div> : null}

            <div className="fresh-start-actions">
              <Button type="button" onClick={back} disabled={busy}>{phase === "failed" ? "Back to Settings" : "Keep my team"}</Button>
              <Button type="button" variant="danger" disabled={busy || !preview || !confirmed} onClick={() => void erase()} data-testid="factory-reset-erase">
                {phase === "resetting" ? "Preparing fresh start..." : phase === "restarting" ? "Waiting for restart..." : phase === "failed" ? "Retry erase & restart" : "Erase & restart"}
              </Button>
            </div>
            <p className="fresh-start-closing">{busy ? "The native app is handling this step." : phase === "failed" ? "Review the native error before choosing your next step." : "A new beginning is optional. Keeping this team is good, too."}</p>
          </section>
        </div>
      </main>
    </div>
  );
}
