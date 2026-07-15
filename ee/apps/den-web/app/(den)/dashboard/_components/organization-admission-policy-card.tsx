"use client";

import type {
  OrganizationAdmissionMethod,
  OrganizationAdmissionPolicy,
} from "@openwork/types/den/organization-admission";
import { ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenTextarea } from "../../_components/ui/textarea";

type PresetId = "open" | "domain_restricted" | "invite_only" | "sso_only" | "scim_managed" | "invite_or_sso";

const METHOD_LABELS: Record<OrganizationAdmissionMethod, string> = {
  self_join: "Explicit self-join",
  invitation: "Invitation",
  sso_jit: "SSO just-in-time",
  scim: "SCIM provisioning",
};

const PRESETS: Array<{ id: PresetId; label: string; description: string }> = [
  { id: "open", label: "Open", description: "People explicitly join or accept an invitation." },
  { id: "domain_restricted", label: "Domain restricted", description: "Self-join and invitations require an allowed email domain." },
  { id: "invite_only", label: "Invite only", description: "Only a valid, one-use invitation grants membership." },
  { id: "sso_only", label: "SSO JIT only", description: "Your verified organization identity provider grants membership." },
  { id: "scim_managed", label: "SCIM managed + SSO", description: "SCIM owns membership lifecycle and browser access requires SSO." },
  { id: "invite_or_sso", label: "Invite or SSO", description: "A valid invitation or the organization identity provider can grant access." },
];

function parsePolicyPayload(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const payload = value as { policy?: unknown; enforcementMode?: unknown };
  if (!payload.policy || typeof payload.policy !== "object") return null;
  const policy = payload.policy as OrganizationAdmissionPolicy;
  if (!Number.isInteger(policy.version) || !Array.isArray(policy.admissionMethods)) return null;
  return {
    policy,
    enforcementMode: payload.enforcementMode === "enforce" ? "enforce" as const : "shadow" as const,
  };
}

function applyPreset(id: PresetId, current: OrganizationAdmissionPolicy): OrganizationAdmissionPolicy {
  switch (id) {
    case "open":
      return { ...current, admissionMethods: ["self_join", "invitation"], emailDomainRule: { mode: "any" }, authenticationRequirement: "any", lifecycleAuthority: "local" };
    case "domain_restricted":
      return {
        ...current,
        admissionMethods: ["self_join", "invitation"],
        emailDomainRule: current.emailDomainRule.mode === "allowlist" ? current.emailDomainRule : { mode: "allowlist", domains: [] },
        authenticationRequirement: "any",
        lifecycleAuthority: "local",
      };
    case "invite_only":
      return { ...current, admissionMethods: ["invitation"], emailDomainRule: { mode: "any" }, authenticationRequirement: "any", lifecycleAuthority: "local" };
    case "sso_only":
      return { ...current, admissionMethods: ["sso_jit"], emailDomainRule: { mode: "any" }, authenticationRequirement: "organization_sso", lifecycleAuthority: "local" };
    case "scim_managed":
      return { ...current, admissionMethods: ["scim"], emailDomainRule: { mode: "any" }, authenticationRequirement: "organization_sso", lifecycleAuthority: "scim" };
    case "invite_or_sso":
      return { ...current, admissionMethods: ["invitation", "sso_jit"], emailDomainRule: { mode: "any" }, authenticationRequirement: "any", lifecycleAuthority: "local" };
  }
}

function matchingPreset(policy: OrganizationAdmissionPolicy): PresetId | null {
  const methods = [...policy.admissionMethods].sort().join(",");
  if (methods === "invitation,self_join" && policy.emailDomainRule.mode === "any" && policy.authenticationRequirement === "any" && policy.lifecycleAuthority === "local") return "open";
  if (methods === "invitation,self_join" && policy.emailDomainRule.mode === "allowlist" && policy.authenticationRequirement === "any" && policy.lifecycleAuthority === "local") return "domain_restricted";
  if (methods === "invitation" && policy.authenticationRequirement === "any" && policy.lifecycleAuthority === "local") return "invite_only";
  if (methods === "sso_jit" && policy.authenticationRequirement === "organization_sso" && policy.lifecycleAuthority === "local") return "sso_only";
  if (methods === "scim" && policy.authenticationRequirement === "organization_sso" && policy.lifecycleAuthority === "scim") return "scim_managed";
  if (methods === "invitation,sso_jit" && policy.authenticationRequirement === "any" && policy.lifecycleAuthority === "local") return "invite_or_sso";
  return null;
}

function normalizeDomainForEditor(value: string) {
  const raw = value.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!raw || raw.includes(":") || raw.includes("/") || raw.includes("@")) return null;
  try {
    const hostname = new URL(`http://${raw}`).hostname.toLowerCase().replace(/\.$/, "");
    const labels = hostname.split(".");
    if (hostname.length > 253 || labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
    return hostname;
  } catch {
    return null;
  }
}

export function OrganizationAdmissionPolicyCard({ organizationId, isOwner, hasOrgControls, hasSso, hasScim }: { organizationId: string; isOwner: boolean; hasOrgControls: boolean; hasSso: boolean; hasScim: boolean }) {
  const [policy, setPolicy] = useState<OrganizationAdmissionPolicy | null>(null);
  const [enforcementMode, setEnforcementMode] = useState<"shadow" | "enforce">("shadow");
  const [domainsDraft, setDomainsDraft] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const canEdit = isOwner && hasOrgControls;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    void requestJson("/v1/org/admission-policy", { method: "GET" }, 12000)
      .then(({ response, payload }) => {
        if (cancelled) return;
        const parsed = parsePolicyPayload(payload);
        if (!response.ok || !parsed) throw new Error(getErrorMessage(payload, "Could not load the admission policy."));
        setPolicy(parsed.policy);
        setDomainsDraft(parsed.policy.emailDomainRule.mode === "allowlist" ? parsed.policy.emailDomainRule.domains.join("\n") : "");
        setEnforcementMode(parsed.enforcementMode);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load the admission policy.");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, [organizationId]);

  const domainState = useMemo(() => {
    const entries = domainsDraft.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
    const normalized = entries.map((entry) => ({ entry, domain: normalizeDomainForEditor(entry) }));
    return {
      domains: [...new Set(normalized.map(({ domain }) => domain).filter((domain): domain is string => Boolean(domain)))],
      invalid: normalized.filter(({ domain }) => !domain).map(({ entry }) => entry),
    };
  }, [domainsDraft]);
  const domains = domainState.domains;
  const selectedPreset = policy ? matchingPreset(policy) : null;
  const validationError = !policy
    ? "Policy is unavailable."
    : policy.admissionMethods.length === 0
      ? "Choose at least one admission method."
      : policy.emailDomainRule.mode === "allowlist" && domains.length === 0
        ? "Add at least one allowed domain."
        : policy.emailDomainRule.mode === "allowlist" && domainState.invalid.length > 0
          ? `Fix invalid domains: ${domainState.invalid.join(", ")}.`
        : (policy.admissionMethods.includes("sso_jit") || policy.authenticationRequirement === "organization_sso") && !hasSso
          ? "Configure and verify organization SSO before selecting an SSO-dependent policy."
          : (policy.admissionMethods.includes("scim") || policy.lifecycleAuthority === "scim") && !hasScim
            ? "Configure SCIM before enabling SCIM admission or lifecycle management."
        : policy.lifecycleAuthority === "scim" && (policy.admissionMethods.length !== 1 || policy.admissionMethods[0] !== "scim")
          ? "SCIM-managed lifecycle requires SCIM as the only admission method."
          : null;

  function updateMethod(method: OrganizationAdmissionMethod, enabled: boolean) {
    if (!policy) return;
    setPolicy({
      ...policy,
      admissionMethods: enabled
        ? [...new Set([...policy.admissionMethods, method])]
        : policy.admissionMethods.filter((entry) => entry !== method),
    });
  }

  async function savePolicy() {
    if (!policy || validationError) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const nextPolicy: OrganizationAdmissionPolicy = {
        ...policy,
        emailDomainRule: policy.emailDomainRule.mode === "allowlist" ? { mode: "allowlist", domains } : { mode: "any" },
      };
      const { response, payload } = await requestJson("/v1/org/admission-policy", {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: policy.version,
          admissionMethods: nextPolicy.admissionMethods,
          emailDomainRule: nextPolicy.emailDomainRule,
          authenticationRequirement: nextPolicy.authenticationRequirement,
          lifecycleAuthority: nextPolicy.lifecycleAuthority,
        }),
      }, 12000);
      const parsed = parsePolicyPayload(payload);
      if (!response.ok || !parsed) throw new Error(getErrorMessage(payload, `Could not save the admission policy (${response.status}).`));
      setPolicy(parsed.policy);
      setDomainsDraft(parsed.policy.emailDomainRule.mode === "allowlist" ? parsed.policy.emailDomainRule.domains.join("\n") : "");
      setEnforcementMode(parsed.enforcementMode);
      setSuccess("Admission policy saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the admission policy.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DenCard size="spacious" className="grid gap-6" data-testid="organization-admission-policy-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-2">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Access and identity</p>
          <h2 className="flex items-center gap-2 text-[24px] font-semibold tracking-[-0.04em] text-gray-900"><ShieldCheck className="h-5 w-5" /> Admission policy</h2>
          <p className="max-w-2xl text-[14px] text-gray-500">Authentication creates a global account. This policy separately decides who may become a member of this organization.</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-[12px] font-medium ${enforcementMode === "enforce" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
          {enforcementMode === "enforce" ? "Enforced" : "Shadow mode"}
        </span>
      </div>

      {enforcementMode === "shadow" ? <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">Automatic legacy paths are being compared with this policy but are not blocked until enforcement is enabled.</div> : null}
      {busy ? <p className="text-[14px] text-gray-500">Loading admission policy...</p> : null}
      {error ? <DenNotice message={error} /> : null}
      {success ? <div className="rounded-[20px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{success}</div> : null}

      {policy ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {PRESETS.map((preset) => (
              <button key={preset.id} type="button" disabled={!canEdit} onClick={() => {
                const next = applyPreset(preset.id, policy);
                setPolicy(next);
                setDomainsDraft(next.emailDomainRule.mode === "allowlist" ? next.emailDomainRule.domains.join("\n") : "");
                setError(null);
                setSuccess(null);
              }} className={`grid gap-1 rounded-[22px] border p-4 text-left transition ${selectedPreset === preset.id ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white hover:border-gray-400"} disabled:cursor-not-allowed disabled:opacity-60`}>
                <span className="text-[14px] font-semibold">{preset.label}</span>
                <span className={`text-[12px] ${selectedPreset === preset.id ? "text-gray-300" : "text-gray-500"}`}>{preset.description}</span>
              </button>
            ))}
          </div>

          {policy.emailDomainRule.mode === "allowlist" ? <label className="grid gap-2"><span className="text-[14px] font-medium text-gray-700">Allowed domains</span><DenTextarea value={domainsDraft} onChange={(event) => setDomainsDraft(event.target.value)} rows={4} disabled={!canEdit} placeholder={"company.com\npartner.org"} /><span className="text-[12px] text-gray-500">Matches exact normalized domains. Subdomains must be listed separately.</span></label> : null}

          <button type="button" className="w-fit text-[13px] font-medium text-gray-700 underline underline-offset-4" onClick={() => setAdvanced((value) => !value)}>{advanced ? "Hide advanced controls" : "Show advanced controls"}</button>
          {advanced ? (
            <div className="grid gap-5 rounded-[24px] border border-gray-200 bg-gray-50 p-5">
              <p className="text-[12px] text-gray-500">SSO JIT and organization SSO require an enabled, domain-verified SSO connection. SCIM lifecycle requires an enabled SCIM connection and SCIM as the only admission method.</p>
              <div className="grid gap-2"><span className="text-[13px] font-semibold text-gray-700">Admission methods</span>{(Object.keys(METHOD_LABELS) as OrganizationAdmissionMethod[]).map((method) => <label key={method} className="flex items-center gap-3 text-[14px] text-gray-700"><input type="checkbox" checked={policy.admissionMethods.includes(method)} disabled={!canEdit} onChange={(event) => updateMethod(method, event.target.checked)} />{METHOD_LABELS[method]}</label>)}</div>
              <label className="grid gap-2 text-[13px] font-semibold text-gray-700">Email domains<select value={policy.emailDomainRule.mode} disabled={!canEdit} onChange={(event) => setPolicy({ ...policy, emailDomainRule: event.target.value === "allowlist" ? { mode: "allowlist", domains } : { mode: "any" } })} className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-[14px] font-normal"><option value="any">Any domain</option><option value="allowlist">Exact allowlist</option></select></label>
              <label className="grid gap-2 text-[13px] font-semibold text-gray-700">Browser authentication<select value={policy.authenticationRequirement} disabled={!canEdit} onChange={(event) => setPolicy({ ...policy, authenticationRequirement: event.target.value === "organization_sso" ? "organization_sso" : "any" })} className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-[14px] font-normal"><option value="any">Any authenticated account</option><option value="organization_sso">Organization SSO required</option></select></label>
              <label className="grid gap-2 text-[13px] font-semibold text-gray-700">Membership lifecycle<select value={policy.lifecycleAuthority} disabled={!canEdit} onChange={(event) => setPolicy({ ...policy, lifecycleAuthority: event.target.value === "scim" ? "scim" : "local" })} className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-[14px] font-normal"><option value="local">Locally managed</option><option value="scim">SCIM managed</option></select></label>
            </div>
          ) : null}
          {validationError ? <DenNotice message={validationError} /> : null}
          {canEdit ? <div className="flex justify-end"><DenButton type="button" loading={saving} disabled={Boolean(validationError)} onClick={() => void savePolicy()}>Save admission policy</DenButton></div> : <p className="text-[13px] text-gray-500">{isOwner ? "Organization controls are required to change admission policy." : "Only workspace owners can change admission policy."}</p>}
        </>
      ) : null}
    </DenCard>
  );
}
