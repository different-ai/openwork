/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "../../../../i18n";

/**
 * The frame every Library step shares: back to Library, where you are, one
 * title, the form, then a footer with a quiet note and the actions. Escape
 * goes back.
 */
export function LibraryPage(props: {
  title: string;
  children: ReactNode;
  /** Steps between Library and this page, e.g. Add a connector › Slack. */
  crumbs?: Array<{ label: string; onClick?: () => void }>;
  icon?: ReactNode;
  subtitle?: string;
  /** A subtitle with its own markup, e.g. a state dot. */
  subtitleNode?: ReactNode;
  /** One action at the top right, next to the title. */
  headerAction?: ReactNode;
  footerNote?: string;
  actions?: ReactNode;
  backDisabled?: boolean;
  onBack: () => void;
  testId?: string;
}) {
  const { backDisabled, onBack } = props;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || backDisabled) return;
      onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [backDisabled, onBack]);

  return (
    <section
      data-testid={props.testId}
      aria-labelledby="library-page-title"
      className="mx-auto flex w-full max-w-3xl flex-col animate-in fade-in duration-300"
    >
      <nav aria-label={t("extensions.page_breadcrumb")} className="mb-4 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit gap-1 px-2 text-muted-foreground"
          aria-label={t("extensions.back_to_library")}
          disabled={props.backDisabled}
          onClick={props.onBack}
        >
          <ChevronLeft size={16} />
          {t("extensions.title")}
        </Button>
        {(props.crumbs ?? []).map((crumb, index) => (
          <span key={`${crumb.label}:${index}`} className="flex min-w-0 items-center gap-1">
            <span aria-hidden="true">/</span>
            {crumb.onClick && !props.backDisabled ? (
              <button type="button" className="truncate rounded px-1 hover:text-dls-text" onClick={crumb.onClick}>
                {crumb.label}
              </button>
            ) : (
              <span className="truncate px-1 text-dls-text" aria-current={index === (props.crumbs?.length ?? 0) - 1 ? "page" : undefined}>
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      <div className="flex items-center gap-3">
        {props.icon ? (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-surface text-dls-secondary">
            {props.icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 id="library-page-title" className="text-xl font-semibold tracking-[-0.01em] text-dls-text">
            {props.title}
          </h1>
          {props.subtitle ? <p className="mt-0.5 text-[13px] text-dls-secondary">{props.subtitle}</p> : null}
          {props.subtitleNode ? <p className="mt-0.5 text-[13px] text-dls-secondary">{props.subtitleNode}</p> : null}
        </div>
        {props.headerAction ? <div className="flex shrink-0 items-center gap-2">{props.headerAction}</div> : null}
      </div>
      <div className="mt-6 flex flex-col gap-5">{props.children}</div>
      {props.actions ? (
        <div className="mt-7 flex items-center gap-2 border-t border-dls-border pt-4">
          {props.footerNote ? <p className="me-auto text-xs text-dls-secondary">{props.footerNote}</p> : <span className="me-auto" />}
          {props.actions}
        </div>
      ) : null}
    </section>
  );
}
