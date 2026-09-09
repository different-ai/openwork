import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ComputerPermission, ComputerSnapshot } from "@/lib/bridge";
import { Button, ErrorNote } from "@/ui/kit";

const permissions: Array<{ id: ComputerPermission; title: string; purpose: string; path: string }> = [
  { id: "accessibility", title: "Accessibility", purpose: "Read app controls and use the mouse and keyboard in an approved session.", path: "Privacy & Security > Accessibility" },
  { id: "screenRecording", title: "Screen Recording", purpose: "See the window you approve. Window observations can be sent to the AI model handling your request.", path: "Privacy & Security > Screen Recording (or Screen & System Audio Recording)" },
];

/** Guidance never grants access. Every status comes from the native helper probe. */
export function ComputerSetup({ snapshot, readError, actionError, refreshing, busy, canAllow, canStop, onPermission, onRefresh, onAllow, onStop, onClose, onBackToConversation }: {
  snapshot: ComputerSnapshot | null;
  readError: string;
  actionError: string;
  refreshing: boolean;
  busy: "allow" | "stop" | "target" | ComputerPermission | null;
  canAllow: boolean;
  canStop: boolean;
  onPermission: (permission: ComputerPermission) => void;
  onRefresh: () => void;
  onAllow: () => void;
  onStop: () => void;
  onClose: () => void;
  onBackToConversation?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    title.current?.focus();
    return () => element?.close();
  }, []);
  function close() {
    // Release the modal's inert background before restoring the Computer trigger.
    dialog.current?.close();
    onClose();
  }
  const verified = readError ? undefined : snapshot?.permissions;
  const ready = snapshot?.readiness === "ready" && verified?.accessibility === true && verified.screenRecording === true;
  const allowed = Boolean(snapshot?.enabled && !snapshot.cleanupPending && !readError);
  const nextPermission = permissions.find((permission) => verified?.[permission.id] === false)?.id;
  const status = readError ? "Could not verify permissions"
    : !snapshot ? "Checking this Mac..."
    : snapshot.readiness === "unsupported" ? "Not supported on this computer"
    : snapshot.readiness === "unavailable" ? "Permission check unavailable"
    : ready ? "Both permissions verified" : "Permissions needed";

  return createPortal(
    <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} data-testid="coworker-computer-setup-dialog"
      className="window-no-drag fixed inset-0 m-auto max-h-[min(620px,calc(100dvh-32px))] w-[min(560px,calc(100vw-32px))] max-w-none overflow-hidden rounded-2xl border border-line bg-ink p-0 text-snow shadow-2xl backdrop:bg-black/65"
      onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="flex max-h-[min(618px,calc(100dvh-34px))] flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line bg-panel px-4 py-3">
          <div>
            <h2 ref={title} tabIndex={-1} id={`${id}-title`} className="text-base font-semibold outline-none">Computer use on this Mac</h2>
            <p id={`${id}-intro`} className="mt-1 text-xs leading-relaxed text-mist">For native Mac apps. Use Browser for websites; it does not need these macOS permissions. Neither is a separate remote computer.</p>
          </div>
          <Button type="button" variant="ghost" className="shrink-0 text-xs" onClick={close} aria-label="Close computer setup">Close</Button>
        </header>
        <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 text-xs leading-relaxed text-mist">
          <ol className="space-y-4">
            <li className="flex gap-3">
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full border border-spark/30 bg-spark/10 text-xs font-medium text-snow">1</span>
              <div className="min-w-0 flex-1 space-y-3">
                <div><h3 className="font-semibold text-snow">macOS permissions {ready ? <span className="ml-1 font-normal text-ready">Verified</span> : null}</h3>
                  <p className="mt-1 text-xs">Requires macOS 14 or later. These are system-wide permissions for the helper, not approval for a task.</p></div>
                <div className="space-y-2">
                  {permissions.map((permission) => {
                    const allowed = verified?.[permission.id];
                    return <section key={permission.id} aria-label={permission.title} className="rounded-xl border border-line bg-panel p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-medium text-snow">{permission.title}</h4>
                        <span data-testid={`coworker-permission-${permission.id}`} className={`rounded-md px-2 py-0.5 text-[11px] ${allowed === true ? "bg-ready/15 text-snow" : "bg-white/5 text-mist"}`}>{allowed === true ? "Verified" : allowed === false ? "Not granted" : "Not verified"}</span>
                      </div>
                      <p className="mt-1.5 text-xs">{permission.purpose}</p>
                      <Button type="button" variant={nextPermission === permission.id && !canStop ? "primary" : "ghost"} className="mt-2 text-xs" title={`System Settings > ${permission.path}`} disabled={busy !== null || canStop || !verified} aria-busy={busy === permission.id} onClick={() => onPermission(permission.id)}>
                        Open {permission.title} settings
                      </Button>
                    </section>;
                  })}
                </div>
                <details className="rounded-lg border border-line px-3 py-2 text-xs">
                  <summary className="cursor-pointer font-medium text-snow">Which app do I enable?</summary>
                  <p className="mt-2">Enable <strong className="font-medium text-snow">OpenWork Computer Use</strong>, the bundled helper. macOS may show Open Coworker as the responsible app. Use the entry macOS identifies for this request, not an unrelated app.</p>
                  <p className="mt-2">Use a settings button above to request access, unlock System Settings if asked, and enable the matching entry. If macOS asks you to quit and reopen, finish your work and restart Open Coworker. Then return here and check permissions. We never change these switches for you.</p>
                </details>
                <div role="status" aria-live="polite" className="text-xs">
                  <span className={ready ? "text-snow" : "text-amber"}>{status}</span>
                  <span className="mt-1 block text-mist">{refreshing ? "Checking the helper now..." : "Checks refresh while this guide is open and when you return. Opening settings alone does not confirm access."}</span>
                </div>
                {readError ? <ErrorNote>{readError}</ErrorNote> : snapshot && ["unsupported", "unavailable"].includes(snapshot.readiness) ? <ErrorNote>{snapshot.detail}</ErrorNote> : null}
              </div>
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line text-xs">2</span>
              <div className="min-w-0"><h3 className="font-semibold text-snow">Allow this discussion {allowed ? <span className="ml-1 font-normal text-ready">Allowed</span> : null}</h3>
                <p className="mt-1 text-xs">Off by default; enabling does not start a task. Other discussions, groups and schedules do not inherit access. Each Worker needs a separate approval for its named task.</p></div>
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line text-xs">3</span>
              <div className="min-w-0"><h3 className="font-semibold text-snow">Approve the native app/window</h3>
                <p className="mt-1 text-xs">A separate native approval appears when the coworker requests a session. Review its purpose and scope. This is not an OS sandbox or blanket approval for purchases, messages or other consequential actions.</p></div>
            </li>
          </ol>
          {allowed ? <p role="status" className="rounded-lg border border-ready/25 bg-ready/5 px-3 py-2 text-snow" data-testid="coworker-computer-setup-ready">Discussion access allowed. Return to the conversation to request a task or review a Worker's access request. Native window approval still comes next.</p> : null}
          <details className="rounded-xl border border-line bg-panel px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-snow">Take over, stop and privacy</summary>
            <p className="mt-2">This is foreground control on your Mac; human input pauses it. No live computer video is shown in chat.</p>
            <p>Use <strong className="font-medium text-snow">Take over</strong> in the native task panel to pause control; <strong className="font-medium text-snow">Continue</strong> there hands it back. <strong className="font-medium text-snow">Stop &amp; revoke</strong> in Coworker disables this discussion and waits for session release. If cleanup is pending, stopping is not yet confirmed.</p>
            <p className="mt-2">Closing this guide or switching discussions does not stop work. macOS permissions stay on until you turn them off in System Settings.</p>
          </details>
          {canStop ? <p className="text-xs text-amber">{snapshot?.cleanupPending ? "Native cleanup is pending. Use Stop & revoke to check release again." : "Access is already allowed or a session still exists. Stop & revoke before changing macOS permissions here."}</p> : null}
          {actionError ? <div role="alert"><ErrorNote>{actionError}</ErrorNote></div> : null}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-panel px-4 py-3">
          <Button type="button" variant="ghost" className="text-xs" disabled={refreshing || busy !== null} aria-busy={refreshing} onClick={onRefresh}>Check permissions</Button>
          {canStop ? <Button type="button" variant="ghost" className="text-xs text-rose" disabled={busy !== null} aria-busy={busy === "stop"} onClick={onStop}>Stop &amp; revoke</Button> : null}
          {ready || allowed ? <Button type="button" variant={allowed ? "primary" : "ghost"} className="text-xs" onClick={() => { close(); onBackToConversation?.(); }}>Back to conversation</Button> : null}
          {ready && !canStop ? <Button type="button" variant="primary" className="text-xs" disabled={!canAllow || refreshing || busy !== null} aria-busy={busy === "allow"} onClick={onAllow}>Allow for this discussion</Button> : null}
        </footer>
      </div>
    </dialog>, document.body,
  );
}
