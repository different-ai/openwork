import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DenApiError, createDenClient, readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type Request = { generation: number; connectionId: string; replacing: boolean; finish: (connected: boolean) => void };
let requestGeneration = 0;
let request: Request | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** UI intent only. The credential is sent through the existing Den client. */
export function openMemberApiKeyDialog(connectionId: string, options: { replacing?: boolean } = {}): Promise<boolean> {
  request?.finish(false);
  return new Promise((finish) => { request = { generation: ++requestGeneration, connectionId, replacing: options.replacing === true, finish }; notify(); });
}

function errorMessage(error: unknown): string {
  if (error instanceof DenApiError) {
    if (error.status === 400) return "That key is not accepted. Paste the raw key and try again.";
    if (error.status === 403) return "You no longer have permission to connect this account. Check your connection access.";
    if (error.status === 404) return "This connection is no longer available. Reload the connection list.";
    if (error.status === 409) return "This connection changed. Reload the connection list and try again.";
  }
  return "OpenWork could not confirm whether the key was saved. Check the connection status before retrying.";
}

function Prompt({ target, close }: { target: Request; close: (connected: boolean) => void }) {
  const field = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hasValue, setHasValue] = useState(false);

  useEffect(() => {
    const run = ++generation.current;
    const initial = readDenSettings();
    const changed = () => {
      const next = readDenSettings();
      if (initial.baseUrl !== next.baseUrl || initial.apiBaseUrl !== next.apiBaseUrl
        || initial.activeOrgId !== next.activeOrgId || initial.authToken !== next.authToken) {
        if (field.current) field.current.value = "";
        close(false);
      }
    };
    window.addEventListener(denSettingsChangedEvent, changed);
    return () => {
      generation.current++;
      window.removeEventListener(denSettingsChangedEvent, changed);
      if (field.current) field.current.value = "";
    };
  }, [close]);

  const submit = async () => {
    if (pending || saved || !field.current) return;
    const run = generation.current;
    let apiKey = field.current.value;
    field.current.value = "";
    setHasValue(false);
    if (!/^[\x21-\x7e]{1,8192}$/.test(apiKey)) { apiKey = ""; setError("Enter only the raw key, without a prefix or spaces."); return; }
    const settings = readDenSettings();
    const organizationId = settings.activeOrgId?.trim() ?? "";
    const token = settings.authToken?.trim() ?? "";
    if (!token || !organizationId) { apiKey = ""; setError("Sign in to OpenWork Cloud and select an organization first."); return; }
    setPending(true);
    setError(null);
    try {
      await createDenClient({ baseUrl: settings.baseUrl, token }).setMyMcpCredential(organizationId, target.connectionId, apiKey);
      apiKey = "";
      if (generation.current !== run) return;
      setSaved(true);
      close(true);
    } catch (cause) {
      apiKey = "";
      if (generation.current === run) setError(errorMessage(cause));
    } finally {
      apiKey = "";
      if (generation.current === run) setPending(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open) close(saved); }}>
    <DialogContent data-testid="member-api-key-dialog" data-ph-no-capture="true">
      <DialogHeader>
        <DialogTitle>{saved ? "Key saved" : `${target.replacing ? "Replace" : "Add"} key for your account`}</DialogTitle>
        <DialogDescription>Use your own key. Never paste it into chat. OpenWork uses it only for your requests.</DialogDescription>
      </DialogHeader>
      {saved ? <p role="status">You saved your key. You can replace it at any time.</p>
        : <FieldGroup>
          <Field data-disabled={pending}>
            <FieldLabel htmlFor="member-api-key-input">Personal access token or API key</FieldLabel>
            <Input ref={field} id="member-api-key-input" data-testid="member-api-key-input" type="password"
              autoComplete="off" spellCheck={false} maxLength={8192} disabled={pending}
              data-ph-no-capture="true" data-private="true" autoFocus
              onChange={(event) => setHasValue(event.currentTarget.value.length > 0)} />
            <FieldDescription>Your key is sent through the existing secure OpenWork connection, not through the conversation.</FieldDescription>
          </Field>
          {pending ? <p role="status">Saving your key…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </FieldGroup>}
      <DialogFooter>
        <Button variant="outline" onClick={() => close(saved)}>{saved ? "Done" : "Close"}</Button>
        {!saved ? <Button disabled={pending || !hasValue} onClick={() => void submit()}>Save key</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

const closePrompt = (connected: boolean) => {
  const current = request;
  request = null;
  notify();
  current?.finish(connected);
};

export function MemberApiKeyDialog() {
  const target = useSyncExternalStore(subscribe, () => request, () => null);
  return target ? <Prompt key={target.generation} target={target} close={closePrompt} /> : null;
}
