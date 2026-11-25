/** @jsxImportSource react */
import { Fragment } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export type LibraryBreadcrumb = { label: string; onClick?: () => void };

export function LibraryBreadcrumbs({ items }: { items: LibraryBreadcrumb[] }) {
  return (
    <nav aria-label={t("extensions.page_breadcrumb")} className="min-w-0 text-sm text-muted-foreground">
      <ol className="flex min-w-0 flex-wrap items-center gap-1">
        {items.map((item, index) => (
          <Fragment key={`${index}:${item.label}`}>
            {index > 0 ? <li aria-hidden="true"><ChevronRight className="size-4 shrink-0" /></li> : null}
            <li className="min-w-0 max-w-full">
              {item.onClick ? (
                <Button variant="ghost" size="sm" className="max-w-full px-2 text-muted-foreground" onClick={item.onClick}>
                  <span className="truncate">{item.label}</span>
                </Button>
              ) : (
                <span aria-current={index === items.length - 1 ? "page" : undefined} className="block truncate px-2 text-foreground">
                  {item.label}
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
