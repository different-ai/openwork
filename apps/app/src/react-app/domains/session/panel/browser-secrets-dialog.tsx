/** @jsxImportSource react */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type { BrowserSecretKind, BrowserSecretSummary } from "@openwork/types/desktop-ipc";

import { markFeatureUsed } from "@/app/lib/den";
import { desktopBridge } from "@/app/lib/desktop";
import { SecretField, type SecretFieldHandle } from "@/components/secret-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import {
  BROWSER_SECRET_KINDS,
  BROWSER_SECRET_NAME_MAX,
  browserSecretKindLabel,
  parseAllowedSites,
  secureOrigin,
  siteName,
} from "./browser-secrets";
import { browserSecretsListKey } from "./use-browser-secrets";

type BrowserSecretsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  pageUrl: string;
};

type Problem = { field: "name" | "sites" | "value" | "save"; message: string };

function SavedSecrets({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const secrets = useQuery({
    queryKey: browserSecretsListKey(sessionId),
    queryFn: () => desktopBridge.browserSecretsList(sessionId),
    retry: false,
    gcTime: 0,
  });
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState("");

  async function remove(secret: BrowserSecretSummary) {
    if (removing) return;
    setRemoving(secret.secretRef);
    setFailed("");
    try {
      await desktopBridge.browserSecretsRemove({ sessionId, secretRef: secret.secretRef });
      await queryClient.invalidateQueries({ queryKey: browserSecretsListKey(sessionId) });
    } catch {
      setFailed(`“${secret.label}” wasn't removed. Try again.`);
    } finally {
      setRemoving(null);
    }
  }

  if (secrets.isPending) return <Skeleton className="h-11 w-full" data-testid="browser-secrets-loading" />;
  if (secrets.isError) {
    return <p role="alert" className="text-sm text-destructive" data-testid="browser-secrets-load-error">This chat's secrets couldn't be read. Close this and open it again.</p>;
  }
  if (!secrets.data.length) {
    return <p className="text-sm text-muted-foreground" data-testid="browser-secrets-empty">Save a password, code or token here and the agent can fill it on the sites you list, without seeing it.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <ul className="divide-y divide-border" data-testid="browser-secrets-list">
        {secrets.data.map((secret) => (
          <li key={secret.secretRef} className="flex min-h-11 items-center gap-3 py-1.5" data-testid="browser-secret">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={secret.label}>{secret.label}</p>
              <p className="break-all text-xs text-muted-foreground">
                {browserSecretKindLabel(secret.kind)} for {secret.origins.map(siteName).join(", ")}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={removing !== null} aria-busy={removing === secret.secretRef}
              aria-label={`Remove ${secret.label}`} data-testid="browser-secret-remove" onClick={() => void remove(secret)}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {failed ? <p role="alert" className="text-sm text-destructive">{failed}</p> : null}
    </div>
  );
}

function BrowserSecretsBody({ sessionId, pageUrl, nameRef, secretField }: {
  sessionId: string;
  pageUrl: string;
  nameRef: React.RefObject<HTMLInputElement | null>;
  secretField: React.RefObject<SecretFieldHandle | null>;
}) {
  const queryClient = useQueryClient();
  const id = React.useId();
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<BrowserSecretKind>("password");
  const [sites, setSites] = React.useState(() => secureOrigin(pageUrl) ?? "");
  const [hasValue, setHasValue] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<Problem | null>(null);
  const kindLabel = browserSecretKindLabel(kind);

  async function save() {
    if (busy || !secretField.current) return;
    const label = name.trim();
    if (!label) return setProblem({ field: "name", message: "Give this secret a name you'll recognize when the agent asks to fill it." });
    const allowed = parseAllowedSites(sites);
    if (!allowed.ok) return setProblem({ field: "sites", message: allowed.error });
    if (!hasValue) return setProblem({ field: "value", message: `Enter the ${kindLabel.toLowerCase()} to save.` });
    let value = secretField.current.take();
    setBusy(true);
    setProblem(null);
    try {
      const result = await desktopBridge.browserSecretsAdd({ sessionId, label, kind, origins: allowed.origins, value });
      value = "";
      if (!result.ok) return setProblem({ field: "save", message: result.error });
      markFeatureUsed("browserSecretHandles");
      setName("");
      await queryClient.invalidateQueries({ queryKey: browserSecretsListKey(sessionId) });
      nameRef.current?.focus();
    } catch {
      setProblem({ field: "save", message: "That wasn't saved. Enter it again and save once more." });
    } finally {
      value = "";
      setBusy(false);
    }
  }

  return (
    <>
      <div className="-mx-6 flex max-h-[min(60dvh,34rem)] flex-col gap-5 overflow-y-auto px-6 py-1">
        <SavedSecrets sessionId={sessionId} />
        <div className="flex flex-col gap-4 border-t border-border pt-5" data-testid="browser-secrets-form">
          <Field data-invalid={problem?.field === "name"}>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input ref={nameRef} id={`${id}-name`} type="text" value={name} maxLength={BROWSER_SECRET_NAME_MAX} autoComplete="off"
              aria-invalid={problem?.field === "name"} placeholder="Billing site sign-in" data-testid="browser-secret-name"
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void save();
              }} />
            {problem?.field === "name" ? <FieldError data-testid="browser-secret-name-error">{problem.message}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel id={`${id}-kind`}>Type</FieldLabel>
            <ToggleGroup aria-labelledby={`${id}-kind`} variant="outline" size="sm" value={[kind]}
              onValueChange={(next) => {
                const chosen = BROWSER_SECRET_KINDS.find((entry) => entry.kind === next[0]);
                if (chosen) setKind(chosen.kind);
              }}>
              {BROWSER_SECRET_KINDS.map((entry) => (
                <ToggleGroupItem key={entry.kind} value={entry.kind} data-testid={`browser-secret-kind-${entry.kind}`}>{entry.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Field data-invalid={problem?.field === "sites"}>
            <FieldLabel htmlFor={`${id}-sites`}>Allowed sites</FieldLabel>
            <Textarea id={`${id}-sites`} value={sites} rows={2} spellCheck={false} autoCapitalize="off" autoCorrect="off"
              aria-invalid={problem?.field === "sites"} aria-describedby={`${id}-sites-note`} placeholder="https://app.example"
              className="font-mono" data-testid="browser-secret-sites" onChange={(event) => setSites(event.currentTarget.value)} />
            {problem?.field === "sites"
              ? <FieldError id={`${id}-sites-note`} data-testid="browser-secret-sites-error">{problem.message}</FieldError>
              : <FieldDescription id={`${id}-sites-note`}>It is only sent to these sites. One https:// address per line.</FieldDescription>}
          </Field>
          <SecretField id={`${id}-value`} testId="browser-secret-value" label={kindLabel} handleRef={secretField} disabled={busy}
            description="Temporary on this computer. Remove it to stop new fills; quit OpenWork to clear its memory."
            error={problem?.field === "value" ? problem.message : null}
            onValueChange={setHasValue} onSubmit={() => void save()} />
          {problem?.field === "save" ? <FieldError data-testid="browser-secret-save-error">{problem.message}</FieldError> : null}
        </div>
      </div>
      <DialogFooter>
        <Button type="button" disabled={busy} aria-busy={busy} data-testid="browser-secret-save" onClick={() => void save()}>Save secret</Button>
      </DialogFooter>
    </>
  );
}

export function BrowserSecretsDialog({ open, onOpenChange, sessionId, pageUrl }: BrowserSecretsDialogProps) {
  const nameRef = React.useRef<HTMLInputElement | null>(null);
  const secretField = React.useRef<SecretFieldHandle | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) secretField.current?.clear();
      onOpenChange(next);
    }}>
      <DialogContent initialFocus={nameRef} data-testid="browser-secrets-dialog" data-browser-secrets-dialog="" data-ph-no-capture="true">
        <DialogHeader>
          <DialogTitle>Secrets for this chat</DialogTitle>
        </DialogHeader>
        <BrowserSecretsBody sessionId={sessionId} pageUrl={pageUrl} nameRef={nameRef} secretField={secretField} />
      </DialogContent>
    </Dialog>
  );
}

export function BrowserSecretsButton({ sessionId, pageUrl }: { sessionId: string; pageUrl: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button variant="ghost" size="icon-sm" aria-label="Secrets for this chat" data-testid="browser-secrets-open" onClick={() => setOpen(true)}>
              <KeyRound />
            </Button>
          )}
        />
        <TooltipContent>Secrets the agent can fill</TooltipContent>
      </Tooltip>
      <BrowserSecretsDialog open={open} onOpenChange={setOpen} sessionId={sessionId} pageUrl={pageUrl} />
    </>
  );
}
