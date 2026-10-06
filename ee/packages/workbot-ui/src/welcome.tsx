"use client";

import { Check } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useWorkbotConnections, type WorkbotConnection } from "./data";
import { AppMark } from "./files";
import { OpenWorkMark } from "./mark";

/**
 * The first thing a person sees, once, before the conversation: a quiet hello, then (when their admins set any up)
 * their everyday apps to connect. Nothing to read about the interface (DESIGN P1); one primary action per step.
 * Each step's parts rise in one after another (V6: 200ms, ease-out, staggered), and leave together.
 */
export function Welcome({ firstName, onBegin, onDone }: { firstName: string | null; onBegin: () => void; onDone: () => void }) {
  const [step, setStep] = useState<"hello" | "connect">("hello");
  const [leaving, setLeaving] = useState(false);
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const connections = useWorkbotConnections({ enabled: true, waiting: waitingFor !== null });
  const list = connections.data ?? [];

  // Stop re-reading once the app the person went to connect is ready.
  useEffect(() => {
    if (waitingFor && list.find((connection) => connection.id === waitingFor)?.ready) setWaitingFor(null);
  }, [list, waitingFor]);

  const leaveTo = (next: () => void) => {
    setLeaving(true);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => {
      next();
      setLeaving(false);
    }, reduced ? 0 : 180);
  };
  const finish = () => leaveTo(onDone);
  const getStarted = () => {
    onBegin();
    // Nothing set up to connect (or the list isn't back yet and failed): straight to the conversation.
    if (list.length === 0) finish();
    else leaveTo(() => setStep("connect"));
  };

  return (
    <div className="workbot flex h-dvh flex-col items-center justify-center bg-[var(--wb-bg)] px-6 antialiased">
      <div key={step} className={`flex w-full max-w-[400px] flex-col items-center text-center ${leaving ? "workbot-welcome-leave" : ""}`}>
        {step === "hello" ? (
          <>
            <Rise order={0}>
              <OpenWorkMark width={40} height={50} className="shrink-0" />
            </Rise>
            <Rise order={1}>
              <h1 className="pt-7 text-[28px] font-semibold leading-[34px] tracking-[-0.02em] text-[var(--wb-text)]">
                Hi{firstName ? ` ${firstName}` : ""}
              </h1>
            </Rise>
            <Rise order={2}>
              <p className="pt-2 text-[15px] leading-[22px] text-[var(--wb-muted)]">Nice to meet you. Welcome to OpenWork.</p>
            </Rise>
            <Rise order={3}>
              <div className="pt-9">
                <PrimaryButton onClick={getStarted} disabled={leaving || connections.isPending}>
                  Get started
                </PrimaryButton>
              </div>
            </Rise>
          </>
        ) : (
          <ConnectStep
            connections={list}
            waitingFor={waitingFor}
            leaving={leaving}
            onConnect={(connection) => {
              if (!connection.connectUrl) return;
              window.open(connection.connectUrl, "_blank", "noopener");
              setWaitingFor(connection.id);
            }}
            onContinue={finish}
          />
        )}
      </div>
    </div>
  );
}

function ConnectStep(props: {
  connections: WorkbotConnection[];
  waitingFor: string | null;
  leaving: boolean;
  onConnect: (connection: WorkbotConnection) => void;
  onContinue: () => void;
}) {
  const allReady = props.connections.every((connection) => connection.ready);
  return (
    <>
      <Rise order={0}>
        <h1 className="text-[22px] font-semibold leading-[28px] tracking-[-0.02em] text-[var(--wb-text)]">
          {allReady ? "You're all connected" : "Connect your apps"}
        </h1>
      </Rise>
      <Rise order={1}>
        <p className="pt-2 text-[14px] leading-5 text-[var(--wb-muted)]">Set up for you by your team.</p>
      </Rise>
      <Rise order={2}>
        <ul className="mt-7 w-[min(400px,calc(100vw-48px))] overflow-hidden rounded-[16px] bg-[var(--wb-surface)] text-left shadow-[var(--wb-card-shadow)]">
          {props.connections.map((connection, index) => (
            <li key={connection.id} className={`flex h-14 items-center gap-3 px-4 ${index > 0 ? "border-t border-[var(--wb-row-line)]" : ""}`}>
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-[var(--wb-chip)]">
                <AppMark name={APP_NAMES[connection.app]} size={18} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-[var(--wb-text)]">{connection.name}</span>
              {connection.ready ? (
                <span className="workbot-reaction flex h-8 shrink-0 items-center gap-1.5 pr-1 text-[13px] leading-4 text-[var(--wb-muted)]">
                  <span className="grid size-[18px] place-items-center rounded-full bg-[var(--wb-ink)] text-[var(--wb-on-ink)]">
                    <Check size={11} strokeWidth={3} aria-hidden />
                  </span>
                  Connected
                </span>
              ) : props.waitingFor === connection.id ? (
                <span className="workbot-shimmer shrink-0 pr-1 text-[13px] leading-4" role="status">
                  Finish in the new tab
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => props.onConnect(connection)}
                  disabled={!connection.connectUrl}
                  className="h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] transition-[box-shadow,background-color] duration-150 ease-out hover:bg-[var(--wb-chip)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
                >
                  Connect
                </button>
              )}
            </li>
          ))}
        </ul>
      </Rise>
      <Rise order={3}>
        <div className="flex flex-col items-center gap-3 pt-8">
          <PrimaryButton onClick={props.onContinue} disabled={props.leaving}>
            Continue
          </PrimaryButton>
          {allReady ? null : (
            <button
              type="button"
              onClick={props.onContinue}
              className="h-8 rounded-full px-3 text-[13px] text-[var(--wb-muted)] transition-colors duration-150 hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              Skip for now
            </button>
          )}
        </div>
      </Rise>
    </>
  );
}

const APP_NAMES: Record<WorkbotConnection["app"], string> = { gmail: "Gmail", slack: "Slack", microsoft: "Microsoft 365" };

/** One part of a step, rising in after the parts before it. */
function Rise({ order, children }: { order: number; children: ReactNode }) {
  const style: CSSProperties = { animationDelay: `${80 + order * 70}ms` };
  return (
    <div className="workbot-welcome-rise flex flex-col items-center" style={style}>
      {children}
    </div>
  );
}

function PrimaryButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-11 min-w-[168px] rounded-full bg-[var(--wb-ink)] px-6 text-[14px] font-medium text-[var(--wb-on-ink)] shadow-[0_6px_16px_-8px_#01162780] transition-[transform,opacity] duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-60 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
    >
      {children}
    </button>
  );
}
