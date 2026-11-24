import Link from "next/link";
import { ChevronRight } from "lucide-react";

type Breadcrumb = { id: string; label: string; href?: string };

export function AdminBreadcrumbs({ items }: { items: Breadcrumb[] }) {
  return (
    <nav aria-label="Breadcrumb" data-testid="admin-breadcrumbs" className="mb-4 text-sm text-slate-600">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-2">
        {items.map((item, index) => (
          <li key={item.id} className="flex min-w-0 max-w-full items-center gap-1">
            {index > 0 ? <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-slate-500" /> : null}
            {index < items.length - 1 && item.href ? (
              <Link href={item.href} prefetch={false} data-testid={`admin-breadcrumb-${item.id}`}
                className="min-w-0 rounded-sm break-words [overflow-wrap:anywhere] hover:text-slate-950 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500">{item.label}</Link>
            ) : <span aria-current="page" data-testid="admin-breadcrumb-current" className="min-w-0 break-words font-medium text-slate-950 [overflow-wrap:anywhere]">{item.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
