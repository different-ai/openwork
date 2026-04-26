export function DenShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] text-[var(--dls-text-primary)]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <span className="absolute inset-x-0 top-0 h-[32rem] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(246,249,252,0))]" />
        <span className="absolute inset-0 bg-[linear-gradient(rgba(1,22,39,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(1,22,39,0.03)_1px,transparent_1px)] bg-[size:56px_56px] opacity-60" />
        <span className="absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(circle_at_top,rgba(1,22,39,0.045),transparent_38%)]" />
      </div>

      <div className="relative z-10 min-h-screen min-h-dvh w-full">
        {children}
      </div>
    </main>
  );
}
