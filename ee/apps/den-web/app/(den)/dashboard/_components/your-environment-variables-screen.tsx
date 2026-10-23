"use client";

import { useState } from "react";
import { Braces, Lock } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenList } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { DenSecretInput } from "../../_components/ui/secret-input";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  clearMyEnvironmentVariableValue,
  selectMyEnvironmentVariableAssignment,
  setMyEnvironmentVariableValue,
  useMyEnvironmentVariables,
  type DenMemberEnvironmentVariable,
} from "./environment-variable-data";

/** Where an admin-provisioned value comes from, as the person sees it. */
function provisionedState(variable: DenMemberEnvironmentVariable): string {
  if (!variable.hasValue) return "Not set yet. Ask an organization admin.";
  const chosen = variable.assignments.find((entry) => entry.accessId === variable.selectedAccessId);
  if (chosen?.kind === "team") return `Set for ${chosen.label}`;
  if (chosen?.kind === "direct") return "Set for you";
  return "Set by your organization";
}

/** Which assignment's value to use when several give the person one. Values stay hidden. */
function AssignmentChoice({ variable, onChanged }: { variable: DenMemberEnvironmentVariable; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex shrink-0 items-center gap-2">
      <Lock aria-hidden className="h-3.5 w-3.5 text-gray-500" />
      <DenSelect
        aria-label={`Value to use for ${variable.key}`}
        value={variable.selectedAccessId ?? ""}
        disabled={busy}
        onChange={async (event) => {
          setBusy(true);
          setError(null);
          try {
            await selectMyEnvironmentVariableAssignment(variable.id, event.target.value || null);
            await onChanged();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : "Couldn't save your choice.");
          } finally {
            setBusy(false);
          }
        }}
        data-testid="my-environment-variable-assignment"
      >
        {variable.assignments.map((entry) => <option key={entry.accessId} value={entry.accessId}>{entry.label}</option>)}
      </DenSelect>
      {error ? <span role="alert" className="text-[12px] text-red-600">{error}</span> : null}
    </span>
  );
}

function VariableRow({ variable, onChanged }: { variable: DenMemberEnvironmentVariable; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setValue("");
      setEditing(false);
      await onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save your value. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-6 py-3" data-testid="my-environment-variable-row" data-key={variable.key}>
      <div className="flex min-h-10 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-gray-900">{variable.name}</span>
            <DenChip mono>{variable.key}</DenChip>
          </div>
          {variable.description ? <p className="truncate text-[12px] text-gray-500">{variable.description}</p> : null}
        </div>
        {variable.editable ? (
          editing ? null : (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[13px] text-gray-500">{variable.hasValue ? "Your value is set" : "Not set"}</span>
              <DenButton size="sm" variant={variable.hasValue ? "secondary" : "primary"} onClick={() => setEditing(true)}>
                {variable.hasValue ? "Replace" : "Add value"}
              </DenButton>
              {variable.hasValue ? (
                <DenButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => clearMyEnvironmentVariableValue(variable.id))}>Clear</DenButton>
              ) : null}
            </div>
          )
        ) : variable.assignments.length > 1 ? (
          <AssignmentChoice variable={variable} onChanged={onChanged} />
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-gray-500" title="Only an organization admin can change this value.">
            <Lock aria-hidden className="h-3.5 w-3.5" />
            {provisionedState(variable)}
          </span>
        )}
      </div>
      {editing ? (
        <form
          className="mt-2 flex items-start gap-2"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (value) void run(() => setMyEnvironmentVariableValue(variable.id, value));
          }}
        >
          <div className="min-w-0 flex-1">
            <DenSecretInput aria-label={`${variable.key} value`} value={value} onChange={setValue} autoFocus autoComplete="new-password" placeholder="Your value" />
          </div>
          <DenButton type="submit" size="sm" loading={busy} disabled={!value}>Save value</DenButton>
          <DenButton type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setValue(""); setError(null); }}>Cancel</DenButton>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-[12px] text-red-600">{error}</p> : null}
    </div>
  );
}

export function YourEnvironmentVariablesScreen() {
  const { orgContext } = useOrgDashboard();
  const enabled = orgFeatureEnabled(orgContext, "environmentVariables");
  const { data, error, loading, reload } = useMyEnvironmentVariables(enabled);
  const variables = data ?? [];
  const missing = variables.filter((variable) => variable.editable && !variable.hasValue).length;

  return (
    <DashboardPageTemplate
      icon={Braces}
      title="My Variables"
      description={missing > 0 ? `${missing} ${missing === 1 ? "variable needs" : "variables need"} your value.` : "Added to your desktop agent's environment."}
    >
      {!enabled ? (
        <DenNotice tone="info" message="Environment variables aren't turned on for this organization yet." />
      ) : loading && !data ? (
        <DenList>
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-3 px-6 py-4" aria-hidden>
              <DenSkeleton className="h-4 w-48" />
              <DenSkeleton className="ml-auto h-8 w-24" />
            </div>
          ))}
        </DenList>
      ) : error ? (
        <div className="flex flex-col items-start gap-3">
          <DenNotice tone="error" message={`${error} Check your connection and try again.`} />
          <DenButton variant="secondary" onClick={() => void reload()}>Try again</DenButton>
        </div>
      ) : variables.length > 0 ? (
        <DenList>
          {variables.map((variable) => <VariableRow key={variable.id} variable={variable} onChanged={reload} />)}
        </DenList>
      ) : (
        <div className="rounded-[16px] border border-dashed border-gray-200 px-6 py-8 text-[14px] text-gray-500">
          Your organization hasn&apos;t given you any environment variables.
        </div>
      )}
    </DashboardPageTemplate>
  );
}
