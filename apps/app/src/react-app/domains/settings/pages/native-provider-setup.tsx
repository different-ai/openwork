import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DenApiError, type DenClient } from "../../../../app/lib/den";
import { TextInput } from "../../../design-system/text-input";
import {
  nativeProviderClientPayload,
  nativeProviderDefaultFeatures,
  nativeProviderPermissions,
  selectNativeProviderFeatures,
  type NativeProviderFields,
  type NativeProviderKey,
} from "./native-provider-setup-fields";

export type NativeProviderSetupProps = {
  providerKey: NativeProviderKey;
  connectionId?: string;
  client: DenClient;
  organizationId: string;
  onSaved: (connectionId: string) => void;
  onCancel: () => void;
  onReauthenticate: (retry: (client: DenClient) => Promise<void>) => void;
};

type ClientMetadata = Awaited<ReturnType<DenClient["getNativeProviderClient"]>>;
type Phase = "loading" | "saving" | "idle" | "saved";

export function NativeProviderSetup(props: NativeProviderSetupProps) {
  const [scope] = useState(() => ({
    providerKey: props.providerKey,
    providerId: props.connectionId ?? props.providerKey,
    organizationId: props.organizationId,
    newGoogle: props.providerKey === "google-workspace" && props.connectionId === undefined,
  }));
  const activeClient = useRef(props.client);
  const callbacks = useRef(props);
  callbacks.current = props;
  const mounted = useRef(false);
  const requestVersion = useRef(0);
  const inFlight = useRef(false);
  const completed = useRef(false);
  const [metadata, setMetadata] = useState<ClientMetadata | null>(null);
  const [name, setName] = useState("Google Workspace");
  const [fields, setFields] = useState<NativeProviderFields>(() => ({
    clientId: "",
    clientSecret: "",
    tenantId: "",
    features: nativeProviderDefaultFeatures(scope.providerKey),
  }));
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [uncertainCreate, setUncertainCreate] = useState(false);

  const run = useCallback(<T,>(
    kind: "loading" | "saving",
    task: (client: DenClient) => Promise<T>,
    onSuccess: (result: T) => void,
    creating = false,
    secret = "",
  ) => {
    if (!mounted.current || inFlight.current || completed.current) return;
    const version = ++requestVersion.current;
    const isCurrent = () => mounted.current && version === requestVersion.current;
    const perform = async (client: DenClient): Promise<void> => {
      if (!isCurrent() || inFlight.current || completed.current) return;
      activeClient.current = client;
      inFlight.current = true;
      setPhase(kind);
      setError(null);
      let result: T;
      try {
        result = await task(client);
      } catch (failure) {
        if (!isCurrent()) return;
        inFlight.current = false;
        setPhase("idle");
        if (failure instanceof DenApiError && failure.code === "reauth") {
          setError("Confirm your identity to continue. Your entries have been kept; changing them will require saving again.");
          let used = false;
          try {
            callbacks.current.onReauthenticate(async (verifiedClient) => {
              if (used || !mounted.current || completed.current) return;
              used = true;
              activeClient.current = verifiedClient;
              if (!isCurrent()) return;
              await perform(verifiedClient);
            });
          } catch {
            setError("Identity confirmation could not start. Try again or cancel setup.");
          }
          return;
        }
        if (creating && (!(failure instanceof DenApiError) || failure.status >= 500)) {
          setUncertainCreate(true);
          setError("Could not confirm whether the connection was created. Close setup and check Library before trying again to avoid a duplicate connection.");
          return;
        }
        const fallback = kind === "loading"
          ? "Could not load provider settings. Check your connection and try again."
          : "Could not save provider settings. Check your connection and try again.";
        const message = failure instanceof DenApiError && failure.message.trim() ? failure.message : fallback;
        setError(secret ? message.split(secret).join("[redacted]") : message);
        return;
      }
      if (!isCurrent()) return;
      inFlight.current = false;
      if (kind === "saving") completed.current = true;
      setPhase(kind === "saving" ? "saved" : "idle");
      onSuccess(result);
    };
    void perform(activeClient.current);
  }, []);

  const load = useCallback(() => {
    run("loading", async (client) => {
      const result = await client.getNativeProviderClient(scope.organizationId, scope.providerId);
      if (!result.redirectUri.trim()) {
        throw new DenApiError(502, "missing_redirect_uri", "The server did not return a redirect URI. Retry loading settings before saving.");
      }
      return result;
    }, (result) => {
      setMetadata(result);
      setFields({
        clientId: scope.newGoogle ? "" : result.clientId ?? "",
        clientSecret: "",
        tenantId: scope.newGoogle ? "" : result.tenantId ?? "",
        features: scope.newGoogle
          ? nativeProviderDefaultFeatures(scope.providerKey)
          : selectNativeProviderFeatures(scope.providerKey, result.features),
      });
    });
  }, [run, scope]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
      inFlight.current = false;
    };
  }, [load]);

  const microsoft = scope.providerKey === "microsoft-365";
  const configured = !scope.newGoogle && metadata?.configured === true;
  const busy = phase === "loading" || phase === "saving";
  const disabled = busy || phase === "saved" || uncertainCreate;
  const fieldsDisabled = disabled || !metadata;
  const payload = nativeProviderClientPayload(scope.providerKey, fields);
  const incomplete = !metadata
    || (scope.newGoogle && !name.trim())
    || (!configured && (!payload.clientId || !payload.clientSecret || (microsoft && !payload.tenantId)));

  function changeField<Key extends keyof NativeProviderFields>(key: Key, value: NativeProviderFields[Key]) {
    requestVersion.current += 1;
    setFields((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  function save() {
    if (disabled || incomplete || inFlight.current || completed.current) return;
    const savedName = name.trim();
    const savedPayload = nativeProviderClientPayload(scope.providerKey, fields);
    run("saving", async (client) => {
      if (scope.newGoogle) {
        if (!savedPayload.clientId) throw new Error("Client ID is required.");
        const connection = await client.createNativeProviderConnection(scope.organizationId, {
          nativeProviderKey: "google-workspace",
          name: savedName,
          oauthClient: { ...savedPayload, clientId: savedPayload.clientId },
        });
        if (!connection.id) throw new Error("Connection ID was not returned.");
        return connection.id;
      }
      await client.saveNativeProviderClient(scope.organizationId, scope.providerId, savedPayload);
      return scope.providerId;
    }, (connectionId) => {
      setFields((current) => ({ ...current, clientSecret: "" }));
      try {
        callbacks.current.onSaved(connectionId);
      } catch {
        setError("Settings were saved, but setup could not continue. Close setup and refresh Library before connecting your account.");
      }
    }, scope.newGoogle, savedPayload.clientSecret);
  }

  return (
    <form
      className="flex min-h-0 flex-col gap-4"
      aria-label={`${microsoft ? "Microsoft 365" : "Google Workspace"} setup`}
      aria-busy={busy}
      onSubmit={(event) => { event.preventDefault(); save(); }}
    >
      <div className="min-h-0 space-y-4 overflow-y-auto">
        <p className="text-xs text-dls-secondary">
          This integration is available to everyone in your organization. Saving settings does not connect anyone's account; each member signs in separately. Credentials stay in your organization's cloud.
        </p>
        <div className="space-y-3 rounded-xl bg-dls-hover/60 p-4">
          <p className="text-xs text-dls-secondary">
            {microsoft
              ? "Create an app registration in Microsoft Entra for accounts in your organization. Add a Web platform with this exact redirect URI, then add the delegated Microsoft Graph permissions selected below. Grant admin consent if your tenant requires it."
              : "Create an OAuth client ID for a Web application in Google Cloud Console. Add this exact authorized redirect URI and enable the Google APIs for the permissions selected below."}
          </p>
          <TextInput
            label="Redirect URI"
            aria-label="Redirect URI"
            readOnly
            autoComplete="off"
            value={metadata?.redirectUri ?? ""}
            placeholder={phase === "loading" ? "Loading redirect URI…" : "Load provider settings to see the redirect URI"}
            onFocus={(event) => event.currentTarget.select()}
          />
          {microsoft ? <p className="text-xs text-dls-secondary">An existing Entra OIDC web app can be reused with this callback and these Graph permissions. SSO and Microsoft 365 consent are separate; a SAML-only app may need a new registration.</p> : null}
        </div>
        {phase === "loading" ? <p role="status" className="text-xs text-dls-secondary">Loading provider settings…</p> : null}
        {configured ? <p className="text-xs text-dls-secondary">Leave the secret empty to keep the encrypted secret already stored. Changing the client ID or tenant disconnects existing member accounts; changing permissions may require members to reconnect.</p> : null}
        {scope.newGoogle ? (
          <TextInput
            label="Name"
            aria-label="Name"
            value={name}
            required
            disabled={fieldsDisabled}
            onChange={(event) => {
              requestVersion.current += 1;
              setName(event.currentTarget.value);
              setError(null);
            }}
          />
        ) : null}
        <TextInput
          label="Client ID"
          aria-label="Client ID"
          value={fields.clientId}
          required={!configured}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={fieldsDisabled}
          onChange={(event) => changeField("clientId", event.currentTarget.value)}
        />
        <TextInput
          label={configured ? "Client secret (optional replacement)" : "Client secret"}
          aria-label="Client secret"
          type="password"
          value={fields.clientSecret}
          required={!configured}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          hint={microsoft ? "Paste the secret value, not its ID. Saved secrets are never displayed." : "Saved secrets are never displayed."}
          disabled={fieldsDisabled}
          onChange={(event) => changeField("clientSecret", event.currentTarget.value)}
        />
        {microsoft ? (
          <TextInput
            label="Directory (tenant) ID"
            aria-label="Directory (tenant) ID"
            value={fields.tenantId}
            required={!configured}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={fieldsDisabled}
            onChange={(event) => changeField("tenantId", event.currentTarget.value)}
          />
        ) : null}
        <fieldset disabled={fieldsDisabled} className="space-y-3 rounded-xl bg-dls-hover/60 p-4">
          <legend className="text-xs font-medium text-dls-secondary">Permissions</legend>
          <p className="text-xs text-dls-secondary">
            Choose exactly what your team can use. Signing in always shares {microsoft ? "the member's basic profile through User.Read" : "the member's name and email"}. No optional features are added when you save; selecting none keeps only sign-in permissions.
          </p>
          {nativeProviderPermissions(scope.providerKey).map((group) => (
            <div key={group.name} className="space-y-2">
              <p className="text-xs font-medium text-dls-secondary">{group.name}</p>
              {group.permissions.map((permission) => (
                <label key={permission.key} className="flex items-start gap-2 text-sm text-dls-text">
                  <input
                    type="checkbox"
                    data-feature={permission.key}
                    className="mt-0.5 h-4 w-4 rounded border-dls-border accent-dls-text"
                    checked={fields.features.includes(permission.key)}
                    onChange={(event) => changeField("features", event.currentTarget.checked
                      ? [...fields.features, permission.key]
                      : fields.features.filter((feature) => feature !== permission.key))}
                  />
                  <span>
                    <span className="block">{permission.label}</span>
                    <span className="block text-xs text-dls-secondary">{permission.scope}</span>
                    {permission.detail ? <span className="block text-xs text-dls-secondary">{permission.detail}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </fieldset>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {!metadata && !busy ? <Button type="button" variant="outline" onClick={load}>Retry loading settings</Button> : null}
        {phase === "saved" ? <p role="status" className="text-sm text-dls-secondary">Settings saved. Your account is not connected by this step; continue with member sign-in.</p> : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => {
          mounted.current = false;
          requestVersion.current += 1;
          setFields((current) => ({ ...current, clientSecret: "" }));
          callbacks.current.onCancel();
        }}>Cancel</Button>
        <Button type="submit" disabled={disabled || incomplete}>{phase === "saving" ? "Saving…" : "Save setup"}</Button>
      </div>
    </form>
  );
}
