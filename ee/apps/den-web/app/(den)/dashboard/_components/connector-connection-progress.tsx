"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { ItemHeader, ItemPage, StepFooter } from "./item-header";
import { ConnectorLogo } from "./item-logo";

/** Only the outstanding decision or recovery, not the four internal setup phases. */
export function ConnectorConnectionProgress({ name, url, back, waitingForSignIn, problem, keyFields, busy, onRetry, onEdit, onCancel }: {
  name: string;
  url: string;
  back: { href: string; label: string };
  waitingForSignIn: boolean;
  problem: string | null;
  keyFields?: ReactNode;
  busy: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
  onCancel: () => void;
}) {
  return <ItemPage testId="connector-connection-progress">
    <ItemHeader back={back} logo={<ConnectorLogo name={name} url={url} size="md" />} title={`Add ${name}`} />
    {keyFields ? <section className="flex flex-col gap-3" aria-label="API key setup">{keyFields}</section> : problem ? (
      <DenNotice tone="error" message={problem} />
    ) : (
      <div className="flex items-start gap-3 border-y border-gray-100 py-4" role="status" aria-live="polite">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 text-gray-500 motion-safe:animate-spin" aria-hidden />
        <div className="min-w-0 text-[13px] leading-5 text-gray-600">
          {waitingForSignIn ? <><p className="font-medium text-gray-900">Finish signing in to {name}</p><p>In the provider tab, approve OpenWork, sign in and choose the account or workspace to connect. Return here when finished.</p></> : <p>{onRetry ? `Sign in to ${name} to finish connecting.` : "Checking the connection and available tools."}</p>}
        </div>
      </div>
    )}
    <StepFooter>
      <DenButton variant="secondary" disabled={busy} onClick={onCancel}>Cancel</DenButton>
      {onEdit ? <DenButton variant="secondary" disabled={busy} onClick={onEdit} data-testid="connector-edit-setup">Edit setup</DenButton> : null}
      {onRetry ? <DenButton disabled={busy} onClick={onRetry}>{problem ? "Check connection again" : `Sign in with ${name}`}</DenButton> : null}
    </StepFooter>
  </ItemPage>;
}
