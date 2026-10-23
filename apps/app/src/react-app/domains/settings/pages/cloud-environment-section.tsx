/** @jsxImportSource react */
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Lock } from "lucide-react";

import { DenApiError, createDenClient, readDenSettings } from "@/app/lib/den";
import type { OpenworkCloudEnvironmentStatus, OpenworkCloudEnvironmentVariable, OpenworkServerClient } from "@/app/lib/openwork-server";
import { SecretField, type SecretFieldHandle } from "@/components/secret-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { clearOpenworkEnvSystemContextCache } from "@/react-app/domains/session/sync/env-context";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { ManagedInDenBadge } from "@/react-app/domains/settings/cloud/managed-in-den-badge";
import { SettingsNotice } from "@/react-app/domains/settings/settings-section";
import { OrganizationMark, ProviderList } from "./provider-rows";
import { EnvironmentVariableTableRevealButton } from "./environment-variable-table";

const MASKED_VALUE_DISPLAY = "••••••••";

const CLOUD_ENVIRONMENT_QUERY_ROOT = ["settings", "environment", "cloud"] as const;

/**
 * Cached per signed-in person and organization: another account's values,
 * including a person's own revealable ones, must never render for the next.
 */
export function cloudEnvironmentQueryKey(runtimeKey: string | null | undefined, identity: string | null) {
  return [...CLOUD_ENVIRONMENT_QUERY_ROOT, runtimeKey, identity];
}

/** The verified Den identity the cached values belong to; null while signed out or unverified. */
function useCloudEnvironmentIdentity(): string | null {
  const auth = useDenAuth();
  const verified = auth.isSignedIn ? auth.verifiedIdentity : null;
  return verified ? `${verified.principalId}:${verified.organizationId}` : null;
}

/** Organization variables, for the local list to mark keys the organization replaces. */
export function useCloudEnvironment(client: OpenworkServerClient | null, runtimeKey?: string | null) {
  const identity = useCloudEnvironmentIdentity();
  const queryClient = useQueryClient();
  // Signing out or switching accounts drops every other identity's cached values.
  useEffect(() => {
    queryClient.removeQueries({
      queryKey: [...CLOUD_ENVIRONMENT_QUERY_ROOT],
      predicate: (query) => query.queryKey[4] !== identity || identity === null,
    });
  }, [identity, queryClient]);
  return useQuery({
    queryKey: cloudEnvironmentQueryKey(runtimeKey, identity),
    queryFn: async (): Promise<OpenworkCloudEnvironmentStatus | null> => {
      if (!client || !identity) return null;
      try {
        return await client.getCloudEnvironment();
      } catch {
        // An older server has no organization variables.
        return null;
      }
    },
    enabled: client !== null && identity !== null,
    staleTime: 30_000,
  });
}

/**
 * Opening settings asks Den now rather than waiting for the next background
 * sync, so a variable an admin just deployed shows up. The last known list
 * stays on screen meanwhile (P11).
 */
function useRefreshCloudEnvironmentOnOpen(client: OpenworkServerClient | null, runtimeKey?: string | null) {
  const queryClient = useQueryClient();
  const identity = useCloudEnvironmentIdentity();
  useEffect(() => {
    if (!client || !identity) return;
    let cancelled = false;
    void client.syncCloudEnvironment().then((next) => {
      if (!cancelled) queryClient.setQueryData(cloudEnvironmentQueryKey(runtimeKey, identity), next);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, queryClient, runtimeKey, identity]);
}

/** Where an admin-provisioned value comes from, as the person sees it. */
function provisionedState(variable: OpenworkCloudEnvironmentVariable): string {
  if (!variable.hasValue) return t("settings.environment.cloud_not_set");
  const chosen = variable.assignments.find((entry) => entry.accessId === variable.selectedAccessId);
  if (chosen?.kind === "team") return t("settings.environment.cloud_set_for_named_team").replace("{team}", chosen.label);
  if (chosen?.kind === "direct") return t("settings.environment.cloud_set_for_you");
  return t("settings.environment.cloud_set_by_org");
}

/**
 * Several assignments give this person a value (e.g. their team's and one
 * set directly for them): they choose which one their agent uses, by name.
 * Values stay hidden.
 */
function AssignmentChoice(props: {
  variable: OpenworkCloudEnvironmentVariable;
  busy: boolean;
  onChoose: (variable: OpenworkCloudEnvironmentVariable, accessId: string) => void;
}) {
  const items = props.variable.assignments.map((entry) => ({ value: entry.accessId, label: entry.label }));
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <Lock className="size-3.5 text-muted-foreground" aria-hidden />
      <Select
        value={props.variable.selectedAccessId ?? undefined}
        items={items}
        onValueChange={(value) => { if (value) props.onChoose(props.variable, value); }}
        disabled={props.busy}
      >
        <SelectTrigger size="sm" className="min-w-40" aria-label={t("settings.environment.cloud_choose_value").replace("{key}", props.variable.key)} data-testid="cloud-environment-assignment">
          <SelectValue />
        </SelectTrigger>
        {/* Fits the longest assignment name ("Everyone in …"), capped to the window (S7). */}
        <SelectContent align="end" className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
          <SelectGroup>
            {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
      <span className="font-mono text-xs text-muted-foreground">{MASKED_VALUE_DISPLAY}</span>
    </div>
  );
}

function CloudVariableRow(props: {
  variable: OpenworkCloudEnvironmentVariable;
  onEdit: (variable: OpenworkCloudEnvironmentVariable) => void;
  onClear: (variable: OpenworkCloudEnvironmentVariable) => void;
  onChoose: (variable: OpenworkCloudEnvironmentVariable, accessId: string) => void;
  clearing: boolean;
}) {
  const { variable } = props;
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5" data-testid="cloud-environment-row" data-key={variable.key} data-editable={variable.editable}>
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-medium text-dls-text">{variable.key}</span>
          <ManagedInDenBadge />
        </div>
        <div className="truncate text-xs text-muted-foreground">{variable.description || variable.name}</div>
      </div>
      {variable.editable ? (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {variable.hasValue ? (
            <>
              <EnvironmentVariableTableRevealButton isRevealed={revealed} onToggleReveal={() => setRevealed((current) => !current)} />
              {revealed ? (
                <code className="max-w-48 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{variable.value ?? ""}</code>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">{MASKED_VALUE_DISPLAY}</span>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">{t("settings.environment.cloud_needs_your_value")}</span>
          )}
          <Button variant={variable.hasValue ? "ghost" : "default"} size="sm" onClick={() => props.onEdit(variable)}>
            {variable.hasValue ? t("settings.environment.cloud_replace") : t("settings.environment.cloud_add_value")}
          </Button>
          {variable.hasValue ? (
            <Button variant="ghost" size="sm" disabled={props.clearing} onClick={() => props.onClear(variable)}>
              {t("settings.environment.cloud_clear")}
            </Button>
          ) : null}
        </div>
      ) : variable.assignments.length > 1 ? (
        <AssignmentChoice variable={variable} busy={props.clearing} onChoose={props.onChoose} />
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={(
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" tabIndex={0}>
                <Lock className="size-3.5" aria-hidden />
                {provisionedState(variable)}
                {variable.hasValue ? <span className="font-mono">{MASKED_VALUE_DISPLAY}</span> : null}
              </span>
            )}
          />
          <TooltipContent>{t("settings.environment.cloud_admin_only")}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function OwnValueDialog(props: {
  variable: OpenworkCloudEnvironmentVariable;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const fieldId = useId();
  const field = useRef<SecretFieldHandle | null>(null);
  const [hasValue, setHasValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const value = field.current?.take() ?? "";
    field.current?.clear();
    setHasValue(false);
    if (!value) {
      setError(t("settings.environment.cloud_enter_value"));
      return;
    }
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) {
      setError(t("settings.environment.cloud_signed_out"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Saved to OpenWork Cloud, never to this device's own list.
      await createDenClient({ baseUrl: settings.baseUrl, token }).setMyEnvironmentVariableValue(orgId, props.variable.id, value);
      await props.onSaved();
      props.onClose();
    } catch (cause) {
      setError(cause instanceof DenApiError && cause.status === 403
        ? t("settings.environment.cloud_admin_only")
        : t("settings.environment.cloud_save_failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) props.onClose(); }}>
      <DialogContent className="w-full max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.environment.cloud_dialog_title").replace("{key}", props.variable.key)}</DialogTitle>
        </DialogHeader>
        <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <SecretField
            id={fieldId}
            label={t("settings.environment.value_label")}
            description={t("settings.environment.cloud_dialog_hint")}
            error={error}
            disabled={saving}
            autoFocus
            handleRef={(handle) => { field.current = handle; }}
            onValueChange={setHasValue}
            onSubmit={() => void save()}
          />
          <DialogFooter className="mt-4">
            <DialogClose disabled={saving} render={<Button type="button" variant="outline" size="sm" disabled={saving} />}>
              {t("settings.environment.cancel")}
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving || !hasValue}>
              {saving ? t("settings.environment.saving") : t("settings.environment.cloud_save_value")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Environment variables deployed from OpenWork Cloud. Admin-provisioned values
 * stay hidden and locked; a variable each person sets is theirs to read and
 * change, and saving sends it to OpenWork Cloud.
 */
export function CloudEnvironmentSection(props: {
  client: OpenworkServerClient | null;
  runtimeKey?: string | null;
}) {
  const { activeOrgName } = useCloudSession();
  const queryClient = useQueryClient();
  const identity = useCloudEnvironmentIdentity();
  const { data } = useCloudEnvironment(props.client, props.runtimeKey);
  useRefreshCloudEnvironmentOnOpen(props.client, props.runtimeKey);
  const [editing, setEditing] = useState<OpenworkCloudEnvironmentVariable | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);

  if (!data?.signedIn || !data.available || data.variables.length === 0) return null;
  const organizationName = activeOrgName || t("settings.environment.cloud_your_org");
  const missing = data.variables.filter((variable) => variable.editable && !variable.hasValue).length;

  const refresh = async () => {
    clearOpenworkEnvSystemContextCache();
    const next = await props.client?.syncCloudEnvironment().catch(() => null);
    if (next) queryClient.setQueryData(cloudEnvironmentQueryKey(props.runtimeKey, identity), next);
    else await queryClient.invalidateQueries({ queryKey: cloudEnvironmentQueryKey(props.runtimeKey, identity) });
  };

  const clear = async (variable: OpenworkCloudEnvironmentVariable) => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) return;
    setClearing(variable.id);
    try {
      await createDenClient({ baseUrl: settings.baseUrl, token }).clearMyEnvironmentVariableValue(orgId, variable.id);
      await refresh();
      toast.success(t("settings.environment.cloud_cleared").replace("{key}", variable.key));
    } catch {
      toast.error(t("settings.environment.cloud_save_failed"));
    } finally {
      setClearing(null);
    }
  };

  const choose = async (variable: OpenworkCloudEnvironmentVariable, accessId: string) => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId || accessId === variable.selectedAccessId) return;
    setClearing(variable.id);
    try {
      await createDenClient({ baseUrl: settings.baseUrl, token }).selectMyEnvironmentVariableAssignment(orgId, variable.id, accessId);
      await refresh();
    } catch {
      toast.error(t("settings.environment.cloud_save_failed"));
    } finally {
      setClearing(null);
    }
  };

  const denUrl = (() => {
    try {
      return new URL("/dashboard/your-environment-variables", readDenSettings().baseUrl).toString();
    } catch {
      return null;
    }
  })();

  return (
    <section className="flex flex-col gap-3" aria-labelledby="environment-organization" data-testid="cloud-environment-section">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {activeOrgName ? <OrganizationMark name={activeOrgName} /> : null}
          <h2 id="environment-organization" className="min-w-0 truncate text-base font-medium text-dls-text">
            {t("settings.environment.cloud_title").replace("{org}", organizationName)}
          </h2>
        </div>
        {denUrl ? (
          <a className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-mr-2")} href={denUrl} target="_blank" rel="noopener noreferrer">
            {t("settings.environment.cloud_open_in_den")}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        ) : null}
      </div>
      {missing > 0 ? (
        <SettingsNotice>
          {(missing === 1 ? t("settings.environment.cloud_missing_one") : t("settings.environment.cloud_missing_many")).replace("{count}", String(missing))}
        </SettingsNotice>
      ) : null}
      {data.lastRun && !data.lastRun.ok ? (
        <SettingsNotice>{t("settings.environment.cloud_stale")}</SettingsNotice>
      ) : null}
      <ProviderList>
        {data.variables.map((variable) => (
          <CloudVariableRow
            key={variable.id}
            variable={variable}
            onEdit={setEditing}
            onClear={(target) => void clear(target)}
            onChoose={(target, accessId) => void choose(target, accessId)}
            clearing={clearing === variable.id}
          />
        ))}
      </ProviderList>
      {editing ? (
        <OwnValueDialog
          variable={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            toast.success(t("settings.environment.cloud_saved").replace("{key}", editing.key));
          }}
        />
      ) : null}
    </section>
  );
}
