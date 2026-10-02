import Link from "next/link";
import type { ReactNode } from "react";

export type AdminSection = "overview" | "free-auto";

const SECTIONS: Array<{ id: AdminSection; label: string; href: string }> = [
  { id: "overview", label: "Overview", href: "/admin" },
  { id: "free-auto", label: "Free Auto usage", href: "/admin/free-auto" },
];

/**
 * Frame for internal backoffice pages: product mark, section tabs and a way
 * back to the cloud panel. New admin pages add a section here and render their
 * content as children.
 */
export function AdminShell({ active, children }: { active: AdminSection; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 pt-5 sm:px-6 lg:px-8">
          <div>
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-500">OpenWork</p>
            <p className="mt-1 text-sm text-slate-600">Internal Den backoffice</p>
          </div>
          <Link href="/" className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Back to cloud panel
          </Link>
          <nav aria-label="Backoffice sections" className="-mb-px flex w-full gap-6">
            {SECTIONS.map((section) => (
              <Link
                key={section.id}
                href={section.href}
                aria-current={section.id === active ? "page" : undefined}
                className={`border-b-2 pb-3 text-sm font-medium transition-colors ${section.id === active ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`}
              >
                {section.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
