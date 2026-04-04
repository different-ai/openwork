type Props = {
  className?: string;
};

const summaryStats = [
  { value: "3", label: "Skills" },
  { value: "3", label: "MCPs" },
  { value: "2", label: "Plugins" },
];

export function LandingCloudWorkersCard(props: Props) {
  return (
    <div
      className={[
        "flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm",
        props.className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Browser chrome */}
      <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50/80 px-4 py-2.5">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <div className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
          <div className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
        </div>
        <div className="flex flex-1 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-1">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span className="truncate text-[11px] text-gray-400">
            share.openworklabs.com/b/01KNB...
          </span>
        </div>
      </div>

      {/* Page content */}
      <div className="flex flex-col gap-5 p-5 md:p-6">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-blue-500">
            Workspace Template
          </div>
          <h3 className="mb-2 text-xl font-medium tracking-tight text-[#011627]">
            SDR for Acme Company
          </h3>
          <p className="text-sm leading-relaxed text-gray-500">
            3 skills, 3 MCPs, and 2 plugins. Ready to import.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {summaryStats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3"
            >
              <div className="text-base font-semibold text-[#011627]">
                {stat.value}
              </div>
              <div className="text-[12px] text-gray-500">{stat.label}</div>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#011627] py-2.5 text-sm font-medium text-white shadow-[0_1px_2px_rgba(17,24,39,0.12)] transition-colors hover:bg-black"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          Open in OpenWork
        </button>
      </div>
    </div>
  );
}
