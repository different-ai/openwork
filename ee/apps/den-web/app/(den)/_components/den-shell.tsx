export function DenShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] text-[var(--dls-text-primary)]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <span className="absolute inset-x-0 top-0 h-[28rem] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(246,249,252,0))]" />
        <span className="absolute inset-0 bg-[linear-gradient(rgba(83,58,253,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(83,58,253,0.04)_1px,transparent_1px)] bg-[size:48px_48px]" />
        <span className="absolute inset-x-0 top-0 h-[26rem] bg-[radial-gradient(circle_at_top_left,rgba(83,58,253,0.09),transparent_34%),radial-gradient(circle_at_top_right,rgba(6,27,49,0.06),transparent_32%)]" />
      </div>

      <div className="relative z-10 min-h-screen min-h-dvh w-full">
        {children}
      </div>
    </main>
  );
}
