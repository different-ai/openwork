import Link from "next/link";
import { DenAdminPanel } from "../../components/den-admin-panel";

export default function AdminPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 pb-5">
        <div>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">OpenWork</p>
          <p className="mt-1 text-sm text-slate-600">Internal Den backoffice</p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
        >
          Back to cloud panel
        </Link>
      </div>

      <div className="mx-auto mb-5 max-w-6xl"><Link className="text-sm font-semibold underline" href="/admin/model-promotions">Manage model promotions</Link></div>
      <DenAdminPanel />
    </main>
  );
}
