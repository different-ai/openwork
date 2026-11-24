/** @jsxImportSource react */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { t } from "../../../i18n";

export function CloudSignInBanner(props: {
  media: ReactNode;
  message: string;
  onSignIn?: () => void;
  testId?: string;
}) {
  return (
    <div data-testid={props.testId} className="flex items-center gap-4 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
      <div className="flex shrink-0 -space-x-1.5" aria-hidden>{props.media}</div>
      <p className="min-w-0 flex-1 text-[13px] text-dls-text">{props.message}</p>
      {props.onSignIn ? (
        <Button size="sm" className="shrink-0" onClick={props.onSignIn}>
          {t("extensions.sign_up_action")}
        </Button>
      ) : null}
    </div>
  );
}

export function CloudSignInEmptyState(props: {
  icon: ReactNode;
  title: string;
  onSignIn?: () => void;
  testId?: string;
}) {
  return (
    <div className="flex min-h-full w-full items-center justify-center px-6 py-8 sm:px-8">
      <Empty variant="ghost" className="flex-none" data-testid={props.testId}>
        <EmptyHeader>
          <EmptyMedia variant="icon">{props.icon}</EmptyMedia>
          <EmptyTitle>{props.title}</EmptyTitle>
        </EmptyHeader>
        {props.onSignIn ? (
          <EmptyContent>
            <Button onClick={props.onSignIn}>{t("extensions.sign_up_action")}</Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
}
