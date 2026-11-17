import { t } from "@/i18n";

export function ArchivedComposerFeedback(props: { archived: boolean; error: string | null }) {
  if (!props.archived && !props.error) return null;
  return (
    <div className="px-4 max-lg:px-3 lg:px-8">
      <div className="max-w-[800px] mx-auto">
        {props.archived ? <p className="mb-2 text-xs text-muted-foreground" data-testid="archived-composer-hint">
          {t("session_management.archived_compose_hint")}
        </p> : null}
        {props.error ? <p role="alert" className="mb-2 text-xs text-destructive">
          {props.error}
        </p> : null}
      </div>
    </div>
  );
}
