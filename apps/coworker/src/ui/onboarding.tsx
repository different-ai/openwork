import type { ReactNode } from "react";
import { CoworkerMark } from "@/ui/brand";

function CloudIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.7">
      <path d="M7.2 18.1h10.2a3.6 3.6 0 0 0 .5-7.2A6 6 0 0 0 6.5 9.6a4.3 4.3 0 0 0 .7 8.5Z" />
      <path d="m9.5 13.2 2.1-2.1 2.1 2.1M11.6 11.3v4.6" />
    </svg>
  );
}

function MacIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current" strokeWidth="1.7">
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
      <path d="M8 19.5h8M12 16v3.5" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 fill-none stroke-current" strokeWidth="1.6">
      <path d="M4.5 10h10M10.8 6.2l3.8 3.8-3.8 3.8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-none stroke-current" strokeWidth="1.7">
      <path d="m3.1 8.3 3 3 6.8-6.7" />
    </svg>
  );
}

function SetupNote({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-mist/85">
      <span className="text-mint"><CheckIcon /></span>
      {children}
    </span>
  );
}

export function OnboardingWelcome({
  onConnect,
  onContinueLocally,
}: {
  onConnect: () => void;
  onContinueLocally: () => void;
}) {
  return (
    <div className="window-shell window-drag flex h-full min-h-[560px] flex-col overflow-y-auto" data-testid="onboarding-welcome">
      <header className="flex shrink-0 items-center justify-between px-6 pb-3 pt-5 md:px-8">
        <div className="flex items-center gap-2.5">
          <CoworkerMark animated label="Open Coworker" size={34} />
          <div className="leading-none">
            <p className="text-[13px] font-semibold tracking-[-0.02em] text-snow">Open Coworker</p>
            <p className="mt-1 text-[8px] font-semibold uppercase tracking-[0.16em] text-mist/70">Powered by OpenWork</p>
          </div>
        </div>
        <button
          type="button"
          className="window-no-drag rounded-full border border-white/9 bg-white/[0.035] px-3.5 py-1.5 text-xs font-medium text-mist transition-colors hover:border-white/16 hover:bg-white/[0.065] hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/45"
          onClick={onConnect}
        >
          Sign in
        </button>
      </header>

      <main className="window-no-drag flex flex-1 items-center justify-center px-6 py-10 md:py-12">
        <section className="w-full max-w-[680px] text-center">
          <CoworkerMark animated className="mx-auto" label="Open Coworker" size={76} />
          <p className="mt-6 text-[10px] font-semibold uppercase tracking-[0.2em] text-spark">Welcome to Open Coworker</p>
          <h1 className="mx-auto mt-2 max-w-[620px] text-[34px] font-semibold leading-[1.08] tracking-[-0.05em] text-snow md:text-[40px]">
            Where should your coworker keep work moving?
          </h1>
          <p className="mx-auto mt-3 max-w-[510px] text-sm leading-6 text-mist">
            Give recurring work a durable teammate. Choose where it runs now; you can change the setup later.
          </p>

          <div className="onboarding-launcher mt-8 overflow-hidden rounded-[24px] border border-white/10 bg-panel/75 p-2 text-left" data-testid="onboarding-launcher">
            <div className="flex items-center justify-between px-3 pb-2 pt-1.5">
              <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-mist/75">Choose where work runs</span>
              <span className="rounded-full bg-spark/12 px-2 py-1 text-[9px] font-semibold text-[#aec4ff]">Setup takes a minute</span>
            </div>

            <button
              type="button"
              className="onboarding-choice onboarding-choice--primary group flex w-full items-center gap-3.5 rounded-[17px] border border-spark/25 bg-spark/10 px-4 py-3.5 text-left transition-colors hover:border-spark/40 hover:bg-spark/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
              data-testid="onboarding-cloud-choice"
              onClick={onConnect}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-spark/25 bg-spark/13 text-[#b7caff]">
                <CloudIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-snow">Continue with OpenWork</span>
                  <span className="rounded-full bg-spark/15 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-[#b8caff]">Recommended</span>
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">Always-on work, shared settings, and organization-approved models.</span>
              </span>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/10 text-mist transition-colors group-hover:border-white/18 group-hover:text-snow">
                <ArrowIcon />
              </span>
            </button>

            <button
              type="button"
              className="onboarding-choice group mt-1 flex w-full items-center gap-3.5 rounded-[17px] border border-transparent px-4 py-3.5 text-left transition-colors hover:border-white/8 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/18"
              data-testid="onboarding-local-choice"
              onClick={onContinueLocally}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] text-mist">
                <MacIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-[13px] font-semibold text-snow">Use this Mac</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">No account required. Work runs locally while Open Coworker is available.</span>
              </span>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-transparent text-mist transition-colors group-hover:border-white/10 group-hover:text-snow">
                <ArrowIcon />
              </span>
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2" aria-label="Included in every setup">
            <SetupNote>Inspectable memory</SetupNote>
            <SetupNote>Your choice of model</SetupNote>
            <SetupNote>Native OpenWork workspace</SetupNote>
          </div>
        </section>
      </main>

      <footer className="flex shrink-0 items-center justify-between gap-4 px-6 pb-5 pt-3 text-[9px] font-medium uppercase tracking-[0.12em] text-mist/55 md:px-8">
        <span>Local-first by design</span>
        <span className="text-right normal-case tracking-normal">Your files stay visible and editable.</span>
      </footer>
    </div>
  );
}
