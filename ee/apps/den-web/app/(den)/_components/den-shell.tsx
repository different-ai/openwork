import type { ReactNode } from "react";

export function DenShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] text-[var(--dls-text-primary)]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <span className="absolute -left-24 top-[-8rem] h-[24rem] w-[24rem] rounded-full bg-[#e2e8f0]/90 blur-[120px]" />
        <span className="absolute right-[-6rem] top-20 h-[20rem] w-[20rem] rounded-full bg-[#c7d2fe]/50 blur-[120px]" />
        <span className="absolute bottom-[-10rem] left-1/3 h-[18rem] w-[18rem] rounded-full bg-[#f1f5f9] blur-[120px]" />
        <span className="absolute inset-x-0 top-0 h-[32rem] bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.75),transparent_70%)]" />
      </div>

      <div className="relative z-10 flex min-h-screen min-h-dvh w-full">
        {children}
      </div>
    </main>
  );
}
