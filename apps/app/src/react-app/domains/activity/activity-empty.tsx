/** @jsxImportSource react */
import { useNavigate } from "react-router";
import { Bell } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { t } from "@/i18n";

/** A4: a quiet bell, one state line and a short hint. The page adds the one next step. */
export function ActivityEmpty({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  return (
    <Empty variant="ghost" className="gap-4 px-6 py-8 text-wrap" data-activity-empty>
      <EmptyHeader className="gap-1">
        <EmptyMedia className="mb-2 text-muted-foreground/60"><Bell className="size-4" strokeWidth={1.5} /></EmptyMedia>
        <EmptyTitle className="text-sm">{t("activity.empty")}</EmptyTitle>
        <EmptyDescription className="text-xs leading-4">{t("activity.empty_description")}</EmptyDescription>
      </EmptyHeader>
      {!compact ? <EmptyContent>
        <Button variant="outline" size="sm" onClick={() => navigate("/extensions")}>
          {t("activity.browse_library")}
        </Button>
      </EmptyContent> : null}
    </Empty>
  );
}
