import Image from "next/image";
import { CloudControlPanel } from "../components/cloud-control";

export default function HomePage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center gap-4 overflow-x-hidden bg-[var(--dls-app-bg)] px-3 py-3 text-[var(--dls-text-primary)] md:px-4 md:py-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <span className="absolute -left-24 top-[-8rem] h-[24rem] w-[24rem] rounded-full bg-slate-200/70 blur-[120px]" />
        <span className="absolute right-[-6rem] top-20 h-[20rem] w-[20rem] rounded-full bg-indigo-100/40 blur-[120px]" />
        <span className="absolute bottom-[-10rem] left-1/3 h-[18rem] w-[18rem] rounded-full bg-slate-100 blur-[120px]" />
      </div>

      <header className="relative z-10 flex w-full max-w-[1180px] flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div className="inline-flex items-center gap-3">
          <Image
            src="/openwork-mark.svg"
            alt=""
            aria-hidden="true"
            width={834}
            height={649}
            className="h-[26px] w-auto"
            priority
            unoptimized
          />
          <div>
            <div className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--dls-text-primary)]">OpenWork</div>
            <div className="text-[12px] text-[var(--dls-text-secondary)]">Den onboarding</div>
          </div>
        </div>

        <div className="inline-flex items-center gap-2 rounded-full border border-[var(--dls-border)] bg-white px-3 py-1.5 text-[12px] font-medium text-[var(--dls-text-secondary)] shadow-[var(--dls-card-shadow)]" aria-label="OpenWork status">
          <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" aria-hidden />
          <span>Guided worker setup</span>
        </div>
      </header>

      <CloudControlPanel />
    </main>
  );
}
