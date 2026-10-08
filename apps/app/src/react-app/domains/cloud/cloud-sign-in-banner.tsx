/** @jsxImportSource react */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { t } from "../../../i18n";

/**
 * Signed out, a page that needs OpenWork Cloud has one primary action:
 * signing in. Library, Automations and Dashboard share this banner so the
 * requirement reads the same on every page, above what it unlocks.
 */
export function CloudSignInBanner(props: {
  /** Leading visual: Library shows the connectors it unlocks, others their page icon. */
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

/** The single-icon tile Automations and Dashboard put in the banner. */
export function CloudSignInBannerIcon(props: { children: ReactNode }) {
  return (
    <span className="flex size-7 items-center justify-center rounded-lg border border-dls-border bg-dls-surface text-dls-secondary [&>svg]:size-4">
      {props.children}
    </span>
  );
}
