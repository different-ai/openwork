type Props = {
  className?: string;
};

function SlackGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.523-2.523 2.526 2.526 0 0 1 2.52-2.52V21.48A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

export function LandingCloudWorkersCard(props: Props) {
  return (
    <div
      className={[
        "landing-shell flex w-full max-w-lg flex-col gap-6 rounded-[2rem] p-4 md:p-8",
        props.className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="landing-chip mb-2 flex w-fit items-center justify-between rounded-full p-1">
        <button
          type="button"
          className="flex items-center gap-2 rounded-full border border-gray-100 bg-white px-4 py-2 text-sm font-medium shadow-sm"
        >
          <div className="h-3 w-3 rounded-full bg-[#f97316]"></div>
          Cloud Workers
        </button>
      </div>

      <div className="landing-shell-soft flex w-full flex-col gap-3 rounded-2xl p-2">
        <div className="group relative cursor-pointer rounded-xl bg-gray-50/80 p-4">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[15px] font-medium text-[#011627] transition-colors group-hover:text-blue-600">
              Founder Ops Pilot
            </div>
            <div className="flex items-center gap-1.5 rounded border border-green-100/50 bg-green-50 px-2 py-1">
              <div className="h-1.5 w-1.5 rounded-full bg-green-500"></div>
              <span className="text-[10px] font-bold tracking-wider text-green-700">READY</span>
            </div>
          </div>
          <div className="mb-4 text-[13px] text-gray-500">Assists with operations and onboarding.</div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-full bg-[#011627] px-4 py-2 text-center text-xs font-medium text-white shadow-sm transition-colors hover:bg-black"
            >
              Open in OpenWork
            </button>
            <button
              type="button"
              className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-center text-xs font-medium text-[#011627] shadow-sm transition-colors hover:bg-gray-50"
            >
              <SlackGlyph />
              Connect to Slack
            </button>
          </div>
        </div>

        <div className="group relative cursor-pointer rounded-xl border border-transparent p-4 transition-colors hover:border-gray-100 hover:bg-gray-50/80">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[15px] font-medium text-[#011627] transition-colors group-hover:text-blue-600">
              Marketing Copilot
            </div>
            <div className="flex items-center gap-1.5 rounded border border-gray-200 bg-gray-50 px-2 py-1">
              <div className="h-1.5 w-1.5 rounded-full bg-gray-400"></div>
              <span className="text-[10px] font-bold tracking-wider text-gray-500">OFFLINE</span>
            </div>
          </div>
          <div className="text-[13px] text-gray-500">Creates draft campaigns from Notion docs.</div>
        </div>
      </div>
    </div>
  );
}
