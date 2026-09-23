/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "../../../../i18n";

/**
 * The frame every Library add step shares: back to Library, one title, the
 * form, then a footer with a quiet note and the actions. Escape goes back.
 */
export function LibraryPage(props: {
  title: string;
  children: ReactNode;
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
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 mb-4 w-fit gap-1 px-2 text-muted-foreground"
        aria-label={t("extensions.back_to_library")}
        disabled={props.backDisabled}
        onClick={props.onBack}
      >
        <ChevronLeft size={16} />
        {t("extensions.title")}
      </Button>
      <h1 id="library-page-title" className="text-xl font-semibold tracking-[-0.01em] text-dls-text">
        {props.title}
      </h1>
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
