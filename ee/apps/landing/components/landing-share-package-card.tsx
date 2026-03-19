import { Check, Shield } from "lucide-react";

type Props = {
  className?: string;
};

function LinkIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>
  );
}

export function LandingSharePackageCard(props: Props) {
  return (
    <div
      className={[
        "landing-shell-soft flex w-full max-w-md flex-col gap-6 rounded-[2rem] p-6 text-center md:p-8",
        props.className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div>
        <h3 className="text-xl font-semibold tracking-tight text-[#011627]">Package Your Worker</h3>
        <p className="mt-1 text-sm text-gray-500">
          Drag and drop skills, agents, or MCPs here to bundle them.
        </p>
      </div>

      <div className="group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50/50 p-8 transition-colors hover:bg-gray-50">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-[#1a44f2] transition-transform group-hover:scale-105">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
        </div>
        <div className="text-[15px] font-medium text-[#011627]">Drop OpenWork files here</div>
        <div className="mt-1 text-[13px] text-gray-400">or click to browse local files</div>
      </div>

      <div className="flex flex-col gap-2 text-left">
        <div className="mb-1 px-1 text-xs font-bold uppercase tracking-wider text-gray-400">Included</div>
        <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#f97316] text-white">
            <Shield size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-[#011627]">Sales Inbound</div>
            <div className="text-[12px] text-gray-500">Agent · v1.2.0</div>
          </div>
          <Check size={16} className="shrink-0 text-green-500" />
        </div>
      </div>

      <button
        type="button"
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[#011627] py-3.5 text-[15px] font-medium text-white shadow-md transition-colors hover:bg-black"
      >
        <LinkIcon />
        Generate Share Link
      </button>
    </div>
  );
}
