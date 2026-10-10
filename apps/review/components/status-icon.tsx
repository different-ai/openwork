/** Lucide-shaped glyphs (V5): the state reads from shape as well as color. */
export function StatusIcon({ state, size = 16 }: { state: string; size?: number }) {
  const key = state.toLowerCase();
  const path = key === "passed"
    ? <path d="m8.5 12.5 2.5 2.5 5-5.5" />
    : key === "failed"
      ? <path d="m15 9-6 6M9 9l6 6" />
      : key === "reference"
        ? <><rect x="7" y="8" width="10" height="8" rx="1" /><path d="m7 14 3-3 3 3 1.5-1.5L17 15" /></>
        : <path d="M12 8v4.5M12 16h.01" />;
  return (
    <svg className={`status-icon ${key}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      {path}
    </svg>
  );
}
