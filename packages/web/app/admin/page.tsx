import Link from "next/link";
import { DenAdminPanel } from "../../components/den-admin-panel";

export default function AdminPage() {
  return (
    <main className="ow-shell">
      <div className="ow-ambient" aria-hidden>
        <span className="ow-blob ow-blob-one" />
        <span className="ow-blob ow-blob-two" />
        <span className="ow-blob ow-blob-three" />
      </div>

      <header className="ow-brand">
        <span className="ow-brand-icon" aria-hidden>
          <span className="ow-brand-icon-core" />
        </span>
        <span className="ow-brand-text">OpenWork</span>
      </header>

      <div className="relative z-10 flex w-full max-w-[92rem] justify-end px-1">
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-full border border-slate-200/80 bg-white/85 px-4 py-2 text-sm font-semibold text-slate-700 shadow-[0_10px_24px_rgba(15,23,42,0.06)] backdrop-blur"
        >
          Back to cloud panel
        </Link>
      </div>

      <DenAdminPanel />
    </main>
  );
}
