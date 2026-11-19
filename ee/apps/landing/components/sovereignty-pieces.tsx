import { sovereigntyLevels, sovereigntySetups } from "../lib/sovereign-ai";

export function SovereigntyLevels() {
  return (
    <ol className="mt-10 grid gap-8 md:grid-cols-5 md:gap-6">
      {sovereigntyLevels.map((level, index) => (
        <li key={level.code} className="border-t border-[var(--lp-border)] pt-5">
          <span aria-hidden="true" className="flex gap-1">
            {sovereigntyLevels.slice(1).map((step, stepIndex) => (
              <span key={step.code} className={`h-1.5 w-5 rounded-full ${stepIndex < index ? "bg-[var(--lp-ink)]" : "bg-[var(--lp-border)]"}`} />
            ))}
          </span>
          <p className="mono mt-4 text-xs text-[var(--lp-muted)]">{level.code}</p>
          <h3 className="mt-2 text-lg font-medium tracking-tight">{level.name}</h3>
          <p className="mt-3 text-sm leading-6 text-[var(--lp-body)]">{level.detail}</p>
        </li>
      ))}
    </ol>
  );
}

export function SovereigntySetups() {
  const [first, second] = sovereigntySetups.columns;
  return (
    <div className="mt-10">
      <div className="hidden grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)] gap-12 border-b border-[var(--lp-border)] pb-4 md:grid">
        <span />
        <h3 className="text-xl font-medium tracking-tight">{first}</h3>
        <h3 className="text-xl font-medium tracking-tight">{second}</h3>
      </div>
      <dl className="divide-y divide-[var(--lp-border)] border-b border-[var(--lp-border)]">
        {sovereigntySetups.rows.map((row) => (
          <div key={row.layer} className="grid gap-3 py-5 text-base leading-7 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)] md:gap-12">
            <dt className="text-sm leading-7 text-[var(--lp-muted)]">{row.layer}</dt>
            {row.values.map((value, index) => (
              <dd key={sovereigntySetups.columns[index]} className="text-[var(--lp-ink)]">
                <span className="block text-sm text-[var(--lp-muted)] md:hidden">{sovereigntySetups.columns[index]}</span>
                {value}
              </dd>
            ))}
          </div>
        ))}
      </dl>
    </div>
  );
}
