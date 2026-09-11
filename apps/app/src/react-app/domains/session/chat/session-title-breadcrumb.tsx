import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";

type SessionTitleBreadcrumbProps = {
  parent: { sessionId: string; title: string } | null;
  onOpenParent: () => void;
  children: ReactNode;
};

export function SessionTitleBreadcrumb({ parent, onOpenParent, children }: SessionTitleBreadcrumbProps) {
  if (!parent) return children;
  const parentTitle = parent.title || t("session.default_title");

  return (
    <nav aria-label="Conversation breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1">
        <li className="min-w-0 max-w-40 max-sm:max-w-24">
          <Tooltip>
            <TooltipTrigger render={
              <Button
                variant="ghost"
                size="sm"
                className="h-6 min-w-0 max-w-full cursor-pointer rounded-md px-1.5 text-[13px] font-normal text-dls-secondary hover:bg-muted hover:text-foreground mac:titlebar-no-drag"
                data-parent-session-back={parent.sessionId}
                data-testid="session-parent-breadcrumb"
                aria-label={`Back to ${parentTitle}`}
                onClick={onOpenParent}
              >
                <span className="truncate">{parentTitle}</span>
              </Button>
            } />
            <TooltipContent>Back to {parentTitle}</TooltipContent>
          </Tooltip>
        </li>
        <li aria-hidden="true" className="shrink-0 text-dls-secondary">
          <ChevronRight data-session-breadcrumb-separator className="size-3.5" />
        </li>
        <li aria-current="page" className="min-w-0">{children}</li>
      </ol>
    </nav>
  );
}
