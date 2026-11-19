"use client";

import { CheckCircle2, Copy, KeyRound, LoaderCircle, RefreshCw, Shield, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSecretInput } from "../../_components/ui/secret-input";
import { DenNotice } from "../../_components/ui/notice";
import { getRequestError, isReauthRequiredError, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags, parseOrgSsoPayload, type DenOrgSsoConnection } from "../../_lib/den-org";
import { issuerProblemFromSave, manualIssuerProblem, OidcIssuerField, parseOidcIssuerCheck, type OidcIssuerCheck } from "./sso-oidc-issuer-field";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

function formatDateTime(value: string | null) {
  if (!value) return "Not configured";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not configured";
  return date.toLocaleString();
}

export type FormMode = "saml" | "oidc";

function readSsoTestMessage(value: unknown) {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "openwork:sso-test-complete") return null;
  if (!("intentId" in value) || typeof value.intentId !== "string") return null;
  return value.intentId;
}

/** Where one connection's requests go: one connection by id, or adding a new one. */
export type SsoConnectionEndpoints = {
  /** GET → { connection }; null while adding a connection. */
  load: string | null;
  /** POST a SAML or OIDC configuration. */
  save: (kind: FormMode) => string;
  /** Delete, test, enable, disable and domain verification hang off this; null while adding. */
  base: string | null;
};

export function ssoConnectionEndpoints(connectionId: string | null): SsoConnectionEndpoints {
  if (!connectionId) {
    return { load: null, save: (kind) => `/v1/sso/connections/${kind}`, base: null };
  }
  const base = `/v1/sso/connections/${encodeURIComponent(connectionId)}`;
  return { load: base, save: (kind) => `${base}/${kind}`, base };
}

export type SsoConnectionPanelProps = {
  endpoints: SsoConnectionEndpoints;
  /** The saved connection after every load or change (null: none). */
  onConnectionChange?: (connection: DenOrgSsoConnection | null) => void;
  /** Adding (endpoints.load null): the new connection was saved. */
  onCreated?: (connection: DenOrgSsoConnection, domainVerificationToken: string | null) => void;
  /** The connection was deleted. */
  onDeleted?: () => void;
  /** A token returned when the connection was just created. */
  initialDomainVerificationToken?: string | null;
};

/** One SSO connection: its setup form, domain verification, test, enable and disable. */
export function SsoConnectionPanel({
  endpoints,
  onConnectionChange,
  onCreated,
  onDeleted,
  initialDomainVerificationToken = null,
}: SsoConnectionPanelProps) {
  const { orgId, orgContext, runReauthableAction } = useOrgDashboard();
  const [connection, setConnectionState] = useState<DenOrgSsoConnection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [domainVerificationToken, setDomainVerificationToken] = useState<string | null>(initialDomainVerificationToken);
  const [requestingDomainToken, setRequestingDomainToken] = useState(false);
  const [verifyingDomain, setVerifyingDomain] = useState(false);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testIntentId, setTestIntentId] = useState<string | null>(null);
  const [startingTest, setStartingTest] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const testPopupRef = useRef<Window | null>(null);
  const testPopupWatcherRef = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("saml");
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [domain, setDomain] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [cert, setCert] = useState("");
  const [audience, setAudience] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState("openid email profile");
  const [skipDiscovery, setSkipDiscovery] = useState(false);
  const [authorizationEndpoint, setAuthorizationEndpoint] = useState("");
  const [tokenEndpoint, setTokenEndpoint] = useState("");
  const [jwksEndpoint, setJwksEndpoint] = useState("");
  const [userInfoEndpoint, setUserInfoEndpoint] = useState("");
  const [tokenEndpointAuthentication, setTokenEndpointAuthentication] = useState<"" | "client_secret_basic" | "client_secret_post">("");

  // The issuer field checks the provider and reports on itself.
  const [issuerCheck, setIssuerCheck] = useState<OidcIssuerCheck>({ state: "idle" });
  const issuerCheckRun = useRef(0);

  function changeOidcIssuer(value: string) {
    issuerCheckRun.current += 1;
    setIssuer(value);
    setIssuerCheck({ state: "idle" });
  }

  /** Reports on the issuer under its field; the save runs the same check on the server. */
  async function checkOidcIssuer(value: string, manual: boolean) {
    const run = ++issuerCheckRun.current;
    const typed = value.trim();
    if (!typed || !orgId) {
      setIssuerCheck({ state: "idle" });
      return;
    }
    if (manual) {
      const problem = manualIssuerProblem(typed);
      setIssuerCheck(problem ? { state: "failed", message: problem } : { state: "idle" });
      return;
    }
    let host = typed;
    try {
      host = new URL(typed).host;
    } catch {
      setIssuerCheck({ state: "failed", message: "Enter the full address, starting with https://." });
      return;
    }
    setIssuerCheck({ state: "checking", host });
    try {
      const { response, payload } = await requestJson("/v1/sso/oidc/check", { method: "POST", headers: getOrgScopedHeaders(), body: JSON.stringify({ issuer: typed }) }, 15000);
      if (run !== issuerCheckRun.current) return;
      // A check that could not run says nothing: the save still checks.
      setIssuerCheck(response.ok ? parseOidcIssuerCheck(payload) : { state: "idle" });
    } catch {
      if (run === issuerCheckRun.current) setIssuerCheck({ state: "idle" });
    }
  }

  function setConnection(next: DenOrgSsoConnection | null) {
    setConnectionState(next);
    onConnectionChange?.(next);
  }

  const access = useMemo(
    () => getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role, orgContext?.currentMember.permissions],
  );

  async function loadSsoConfig(isCurrent = () => true, quiet = false) {
    if (!orgId || !access.canViewSso || !endpoints.load) {
      if (isCurrent()) {
        setConnection(null);
        setLoaded(true);
      }
      return;
    }
    const loadPath = endpoints.load;

    if (isCurrent() && !quiet) {
      setBusy(true);
      setError(null);
    }
    try {
      const { response, payload } = await requestJson(loadPath, { method: "GET", headers: getOrgScopedHeaders() }, 12000);
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to load SSO settings (${response.status}).`);
      }

      const parsed = parseOrgSsoPayload(payload);
      if (isCurrent()) {
        setConnection(parsed.connection);
        setLoaded(true);
        if (!quiet) {
          syncFormFromConnection(parsed.connection);
          setEditing(false);
        }
      }
    } catch (nextError) {
      if (isReauthRequiredError(nextError)) {
        throw nextError;
      }

      if (isCurrent() && !quiet) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load SSO settings.");
      }
    } finally {
      if (isCurrent() && !quiet) {
        setBusy(false);
      }
    }
  }

  function getOrgScopedHeaders() {
    const headers = new Headers();
    if (orgId) {
      headers.set("x-openwork-legacy-org-id", orgId);
    }
    return headers;
  }

  function syncFormFromConnection(nextConnection: DenOrgSsoConnection | null) {
    if (!nextConnection) {
      return;
    }

    setFormMode(nextConnection.kind);
    setName(nextConnection.name ?? "");
    setIssuer(nextConnection.issuer);
    issuerCheckRun.current += 1;
    setIssuerCheck({ state: "idle" });
    setDomain(nextConnection.domains.join(", ") || nextConnection.domain);
    if (nextConnection.saml) {
      setEntryPoint(nextConnection.saml.entryPoint ?? "");
      setAudience(nextConnection.saml.audience ?? "");
    }
    if (nextConnection.oidc) {
      setClientId(nextConnection.oidc.clientId ?? "");
      setScopes(nextConnection.oidc.scopes.length > 0 ? nextConnection.oidc.scopes.join(" ") : "openid email profile");
      // Saved connections always store their endpoints; with the setup check the form starts from discovery again.
      setSkipDiscovery(false);
      setAuthorizationEndpoint(nextConnection.oidc.authorizationEndpoint ?? "");
      setTokenEndpoint(nextConnection.oidc.tokenEndpoint ?? "");
      setJwksEndpoint(nextConnection.oidc.jwksEndpoint ?? "");
      setUserInfoEndpoint(nextConnection.oidc.userInfoEndpoint ?? "");
      setTokenEndpointAuthentication(nextConnection.oidc.tokenEndpointAuthentication ?? "");
    }
  }

  useEffect(() => {
    let active = true;
    void runReauthableAction("load-sso-settings", () => loadSsoConfig(() => active)).catch((nextError) => {
      if (active) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load SSO settings.");
      }
    });
    return () => {
      active = false;
    };
  }, [orgId, access.canViewSso, endpoints.load]);

  useEffect(() => {
    if (!copiedValue) return;
    const timeout = window.setTimeout(() => setCopiedValue(null), 1500);
    return () => window.clearTimeout(timeout);
  }, [copiedValue]);

  useEffect(() => {
    if (!testDialogOpen || connection?.testStatus !== "testing") return;
    const interval = window.setInterval(() => void loadSsoConfig(() => true, true), 1000);
    return () => window.clearInterval(interval);
  }, [testDialogOpen, connection?.testStatus, orgId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const completedIntentId = readSsoTestMessage(event.data);
      if (event.origin !== window.location.origin || !completedIntentId || completedIntentId !== testIntentId) return;
      stopTestPopupWatcher();
      testPopupRef.current?.close();
      testPopupRef.current = null;
      void loadSsoConfig(() => true, true);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [testIntentId, orgId]);

  function stopTestPopupWatcher() {
    if (testPopupWatcherRef.current !== null) {
      window.clearInterval(testPopupWatcherRef.current);
      testPopupWatcherRef.current = null;
    }
  }

  async function cancelTestIntent(intentId: string) {
    await requestJson(`/v1/sso/test/${encodeURIComponent(intentId)}/cancel`, {
      method: "POST",
      headers: getOrgScopedHeaders(),
      body: JSON.stringify({}),
    }, 12000);
    await loadSsoConfig(() => true, true);
  }

  function watchTestPopup(popup: Window, intentId: string) {
    stopTestPopupWatcher();
    testPopupRef.current = popup;
    testPopupWatcherRef.current = window.setInterval(() => {
      if (!popup.closed) return;
      stopTestPopupWatcher();
      testPopupRef.current = null;
      void cancelTestIntent(intentId);
    }, 500);
  }

  async function copyValue(value: string | null, key: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(key);
    } catch {
      setError("Could not copy that SSO value.");
    }
  }

  async function handleSave() {
    if (!orgId) {
      setError("Organization not found.");
      return;
    }
    if (!access.canManageSso) {
      setError("You don't have permission to change SSO settings.");
      return;
    }

    setError(null);
    try {
      await runReauthableAction("save-sso-settings", async () => {
        setSaving(true);
        try {
          const path = endpoints.save(formMode);
          const domainFields = { domains: domain.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean), name: name.trim() || null };
          const body = formMode === "saml"
            ? {
                issuer,
                ...domainFields,
                entryPoint,
                cert,
                audience: audience || undefined,
              }
            : {
                issuer,
                ...domainFields,
                clientId,
                clientSecret,
                scopes: scopes.split(/\s+/).map((entry) => entry.trim()).filter(Boolean),
                skipDiscovery,
                authorizationEndpoint: authorizationEndpoint || undefined,
                tokenEndpoint: tokenEndpoint || undefined,
                jwksEndpoint: jwksEndpoint || undefined,
                userInfoEndpoint: userInfoEndpoint || undefined,
                tokenEndpointAuthentication: tokenEndpointAuthentication || undefined,
              };

          const { response, payload } = await requestJson(path, { method: "POST", headers: getOrgScopedHeaders(), body: JSON.stringify(body) }, 20000);
          if (!response.ok) {
            const issuerProblem = formMode === "oidc" && response.status === 400 ? issuerProblemFromSave(payload) : null;
            if (issuerProblem) {
              // The issuer was refused: say so on its field, not in the page banner.
              issuerCheckRun.current += 1;
              setIssuerCheck({ state: "failed", message: issuerProblem });
              return;
            }
            throw getRequestError(payload, response, `Failed to save SSO settings (${response.status}).`);
          }

          const parsed = parseOrgSsoPayload(payload);
          if (!endpoints.load && parsed.connection && onCreated) {
            onCreated(parsed.connection, parsed.domainVerificationToken);
            return;
          }
          setConnection(parsed.connection);
          syncFormFromConnection(parsed.connection);
          setDomainVerificationToken(parsed.domainVerificationToken);
          setEditing(false);
        } finally {
          setSaving(false);
        }
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save SSO settings.");
    }
  }

  async function handleDelete() {
    if (!access.canManageSso) {
      setError("You don't have permission to delete SSO settings.");
      return;
    }

    if (!orgId || !endpoints.base || !window.confirm(`Delete ${connection?.displayName ?? "this SSO connection"}? People who sign in through it will need another connection or sign-in method.`)) {
      return;
    }
    const basePath = endpoints.base;

    setError(null);
    try {
      await runReauthableAction("delete-sso-settings", async () => {
        setDeleting(true);
        try {
          const { response, payload } = await requestJson(basePath, { method: "DELETE", headers: getOrgScopedHeaders() }, 12000);
          if (response.status !== 204 && !response.ok) {
            throw getRequestError(payload, response, `Failed to delete SSO settings (${response.status}).`);
          }
          setConnection(null);
          setEditing(false);
          if (onDeleted) {
            onDeleted();
            return;
          }
          await loadSsoConfig();
        } finally {
          setDeleting(false);
        }
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete SSO settings.");
    }
  }

  async function handleRequestDomainToken() {
    if (!access.canManageSso) {
      setError("You don't have permission to request SSO domain verification tokens.");
      return;
    }
    if (!orgId || !connection || !endpoints.base) return;
    setError(null);
    try {
      await runReauthableAction("request-sso-domain-token", async () => {
        setRequestingDomainToken(true);
        try {
          const { response, payload } = await requestJson(`${endpoints.base}/request-domain-verification`, { method: "POST", headers: getOrgScopedHeaders(), body: JSON.stringify({}) }, 12000);
          if (!response.ok) {
            throw getRequestError(payload, response, `Failed to request domain verification (${response.status}).`);
          }

          const token = typeof (payload as { domainVerificationToken?: unknown } | null)?.domainVerificationToken === "string"
            ? (payload as { domainVerificationToken: string }).domainVerificationToken
            : "";
          if (!token) {
            throw new Error("SSO domain verification token was missing from the response.");
          }
          setDomainVerificationToken(token);
        } finally {
          setRequestingDomainToken(false);
        }
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to request domain verification.");
    }
  }

  async function handleVerifyDomain() {
    if (!access.canManageSso) {
      setError("You don't have permission to verify SSO domains.");
      return;
    }
    if (!orgId || !connection || !endpoints.base) return;
    setError(null);
    try {
      await runReauthableAction("verify-sso-domain", async () => {
        setVerifyingDomain(true);
        try {
          const { response, payload } = await requestJson(`${endpoints.base}/verify-domain`, { method: "POST", headers: getOrgScopedHeaders(), body: JSON.stringify({}) }, 12000);
          if (response.status !== 204 && !response.ok) {
            throw getRequestError(payload, response, `Failed to verify domain (${response.status}).`);
          }
          setDomainVerificationToken(null);
          await loadSsoConfig();
        } finally {
          setVerifyingDomain(false);
        }
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to verify the SSO domain.");
    }
  }

  async function handleStartTest() {
    if (!orgId || !connection || !endpoints.base || !access.canManageSso) return;
    const popup = window.open("", "openwork-sso-test", "popup,width=520,height=720");
    if (!popup) {
      setError("OpenWork could not open the SSO test window. Allow popups, then try again.");
      return;
    }

    setStartingTest(true);
    setTestDialogOpen(true);
    setError(null);
    try {
      await runReauthableAction("test-sso-settings", async () => {
        const { response, payload } = await requestJson(`${endpoints.base}/test`, {
          method: "POST",
          headers: getOrgScopedHeaders(),
          body: JSON.stringify({}),
        }, 12000);
        if (!response.ok) throw getRequestError(payload, response, `Failed to start the SSO test (${response.status}).`);
        const intentId = typeof payload === "object" && payload !== null && "intentId" in payload && typeof payload.intentId === "string"
          ? payload.intentId
          : "";
        const testUrl = typeof payload === "object" && payload !== null && "testUrl" in payload && typeof payload.testUrl === "string"
          ? payload.testUrl
          : "";
        if (!intentId || !testUrl) throw new Error("The SSO test response was incomplete. Try again.");
        setTestIntentId(intentId);
        popup.location.href = testUrl;
        watchTestPopup(popup, intentId);
        await loadSsoConfig(() => true, true);
      });
    } catch (nextError) {
      popup.close();
      setTestDialogOpen(false);
      setError(nextError instanceof Error ? nextError.message : "Failed to start the SSO authentication test.");
    } finally {
      setStartingTest(false);
    }
  }

  function handleOpenTestDialog() {
    setTestIntentId(null);
    setTestDialogOpen(true);
  }

  async function handleEnable() {
    if (!access.canManageSso || !endpoints.base) return;
    setEnabling(true);
    setError(null);
    try {
      await runReauthableAction("enable-sso-settings", async () => {
        const { response, payload } = await requestJson(`${endpoints.base}/enable`, {
          method: "POST",
          headers: getOrgScopedHeaders(),
          body: JSON.stringify({}),
        }, 12000);
        if (response.status !== 204 && !response.ok) throw getRequestError(payload, response, `Failed to enable SSO (${response.status}).`);
        setTestDialogOpen(false);
        setTestIntentId(null);
        await loadSsoConfig();
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to enable SSO.");
    } finally {
      setEnabling(false);
    }
  }

  async function handleDisable() {
    const disablePrompt = `Disable ${connection?.displayName ?? "this connection"}? People who sign in through it will use another connection or sign-in method.`;
    if (!access.canManageSso || !endpoints.base || !window.confirm(disablePrompt)) return;
    setDisabling(true);
    setError(null);
    try {
      await runReauthableAction("disable-sso-settings", async () => {
        const { response, payload } = await requestJson(`${endpoints.base}/disable`, {
          method: "POST",
          headers: getOrgScopedHeaders(),
          body: JSON.stringify({}),
        }, 12000);
        if (response.status !== 204 && !response.ok) throw getRequestError(payload, response, `Failed to disable SSO (${response.status}).`);
        await loadSsoConfig();
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to disable SSO.");
    } finally {
      setDisabling(false);
    }
  }

  function closeTestDialog() {
    setTestDialogOpen(false);
    if (testIntentId && connection?.testStatus === "testing") {
      testPopupRef.current?.close();
      void cancelTestIntent(testIntentId);
    }
    stopTestPopupWatcher();
    testPopupRef.current = null;
  }

  function handleCancelEdit() {
    syncFormFromConnection(connection);
    setEditing(false);
  }

  const formReadOnly = !access.canManageSso;
  const showConnectionForm = access.canViewSso && (!connection || editing || formReadOnly);

  if (!orgContext || !access.canViewSso) {
    return null;
  }

  const ssoFormDisabled = formReadOnly || saving || !orgContext.entitlements.sso;
  const oidcSetupCheck = formMode === "oidc";
  const manualEndpointFields = (
    <>
      <label className="block text-[14px] text-gray-700 md:col-span-2">
        <span className="mb-2 block font-medium">Authorization endpoint</span>
        <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={authorizationEndpoint} onChange={(event) => setAuthorizationEndpoint(event.target.value)} placeholder="https://idp.example.com/oauth2/v1/authorize" disabled={ssoFormDisabled} />
      </label>
      <label className="block text-[14px] text-gray-700 md:col-span-2">
        <span className="mb-2 block font-medium">Token endpoint</span>
        <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={tokenEndpoint} onChange={(event) => setTokenEndpoint(event.target.value)} placeholder="https://idp.example.com/oauth2/v1/token" disabled={ssoFormDisabled} />
      </label>
      <label className="block text-[14px] text-gray-700 md:col-span-2">
        <span className="mb-2 block font-medium">JWKS endpoint</span>
        <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={jwksEndpoint} onChange={(event) => setJwksEndpoint(event.target.value)} placeholder="https://idp.example.com/oauth2/v1/keys" disabled={ssoFormDisabled} />
      </label>
      <label className="block text-[14px] text-gray-700 md:col-span-2">
        <span className="mb-2 block font-medium">UserInfo endpoint</span>
        <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={userInfoEndpoint} onChange={(event) => setUserInfoEndpoint(event.target.value)} placeholder="Optional" disabled={ssoFormDisabled} />
      </label>
    </>
  );

  return (
    <>
          {error ? <DenNotice message={error} className="mb-6" /> : null}

          {showConnectionForm ? (
            <div className="mb-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <DenButton variant={formMode === "saml" ? "primary" : "secondary"} onClick={() => setFormMode("saml")} disabled={formReadOnly || saving}>SAML</DenButton>
                  <DenButton variant={formMode === "oidc" ? "primary" : "secondary"} onClick={() => setFormMode("oidc")} disabled={formReadOnly || saving}>OIDC</DenButton>
                </div>
                {connection && editing ? <DenButton variant="secondary" onClick={handleCancelEdit}>Cancel edit</DenButton> : null}
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <label className="block text-[14px] text-gray-700 md:col-span-2">
                  <span className="mb-2 block font-medium">Name on the sign-in button</span>
                  <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder={connection?.displayName ?? "Okta"} disabled={ssoFormDisabled} data-testid="sso-connection-name" />
                </label>
                {oidcSetupCheck ? (
                  <OidcIssuerField
                    value={issuer}
                    onChange={changeOidcIssuer}
                    onCheck={(value) => void checkOidcIssuer(value, skipDiscovery)}
                    check={issuerCheck}
                    onUseIssuer={(next) => {
                      changeOidcIssuer(next);
                      void checkOidcIssuer(next, skipDiscovery);
                    }}
                    manual={skipDiscovery}
                    onManualChange={(next) => {
                      setSkipDiscovery(next);
                      void checkOidcIssuer(issuer, next);
                    }}
                    manualFields={manualEndpointFields}
                    disabled={ssoFormDisabled}
                  />
                ) : (
                  <label className="block text-[14px] text-gray-700">
                    <span className="mb-2 block font-medium">{formMode === "saml" ? "IdP Issuer URL" : "Issuer URL"}</span>
                    <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={issuer} onChange={(event) => setIssuer(event.target.value)} placeholder="https://idp.example.com" disabled={ssoFormDisabled} />
                  </label>
                )}
                <label className={`block text-[14px] text-gray-700 ${oidcSetupCheck ? "md:col-span-2" : ""}`}>
                  <span className="mb-2 block font-medium">Email domains</span>
                  <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example.com, example.org" disabled={ssoFormDisabled} data-testid="sso-connection-domains" />
                </label>
                {formMode === "saml" ? (
                  <>
                    <label className="block text-[14px] text-gray-700 md:col-span-2">
                      <span className="mb-2 block font-medium">SAML Entry Point</span>
                      <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={entryPoint} onChange={(event) => setEntryPoint(event.target.value)} placeholder="https://idp.example.com/sso" disabled={ssoFormDisabled} />
                    </label>
                    <label className="block text-[14px] text-gray-700 md:col-span-2">
                      <span className="mb-2 block font-medium">Audience URL</span>
                      <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="Defaults to the OpenWork auth URL" disabled={ssoFormDisabled} />
                    </label>
                    <label className="block text-[14px] text-gray-700 md:col-span-2">
                      <span className="mb-2 block font-medium">IdP Certificate</span>
                      <textarea className="min-h-[140px] w-full rounded-[18px] border border-gray-200 px-4 py-3" value={cert} onChange={(event) => setCert(event.target.value)} placeholder="Certificate is not returned after save" disabled={ssoFormDisabled} />
                      <span className="mt-1 block text-[12px] text-gray-500">Certificates are not returned after save; enter a replacement only when editing.</span>
                    </label>
                    <div className="rounded-[18px] border border-gray-200 px-4 py-3 text-[14px] leading-6 text-gray-600 md:col-span-2">
                      OpenWork always requires signed SAML assertions, timestamps, and SP-initiated responses for organization SAML connections.
                    </div>
                  </>
                ) : (
                  <>
                    <label className="block text-[14px] text-gray-700">
                      <span className="mb-2 block font-medium">Client ID</span>
                      <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={clientId} onChange={(event) => setClientId(event.target.value)} disabled={ssoFormDisabled} />
                    </label>
                    <label className="block text-[14px] text-gray-700">
                      <span className="mb-2 block font-medium">Client Secret</span>
                      <DenSecretInput autoComplete="new-password" value={clientSecret} onChange={setClientSecret} placeholder="Secret is not returned after save" disabled={ssoFormDisabled} />
                      <span className="mt-1 block text-[12px] text-gray-500">Client secrets are never returned by Den.</span>
                    </label>
                    <label className="block text-[14px] text-gray-700 md:col-span-2">
                      <span className="mb-2 block font-medium">Scopes</span>
                      <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder="openid email profile" disabled={ssoFormDisabled} />
                    </label>
                    <label className="block text-[14px] text-gray-700 md:col-span-2">
                      <span className="mb-2 block font-medium">Token endpoint auth method</span>
                      <select className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={tokenEndpointAuthentication} onChange={(event) => setTokenEndpointAuthentication(event.target.value === "client_secret_basic" || event.target.value === "client_secret_post" ? event.target.value : "")} disabled={ssoFormDisabled}>
                        <option value="">Use provider default</option>
                        <option value="client_secret_basic">client_secret_basic</option>
                        <option value="client_secret_post">client_secret_post</option>
                      </select>
                    </label>
                    {oidcSetupCheck ? null : (
                      <>
                        <label className="flex items-center gap-3 rounded-[18px] border border-gray-200 px-4 py-3 text-[14px] text-gray-700 md:col-span-2">
                          <input type="checkbox" checked={skipDiscovery} onChange={(event) => setSkipDiscovery(event.target.checked)} disabled={ssoFormDisabled} />
                          Use manual OIDC endpoints instead of discovery
                        </label>
                        {skipDiscovery ? manualEndpointFields : null}
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <DenButton variant="primary" icon={RefreshCw} onClick={() => void handleSave()} disabled={ssoFormDisabled}>{saving ? "Saving..." : connection ? "Save SSO connection" : "Add SSO connection"}</DenButton>
                {connection ? (
                  <DenButton variant="secondary" icon={Trash2} onClick={() => void handleDelete()} disabled={deleting || !connection || !access.canManageSso}>{deleting ? "Deleting..." : "Delete connection"}</DenButton>
                ) : null}
              </div>
            </div>
          ) : null}

          {!connection ? null : (
          <div id="sso-connection" className="scroll-mt-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[16px] font-semibold tracking-[-0.03em] text-gray-900">{connection.displayName}</p>
              </div>
              {connection && !editing ? (
                <div className="flex flex-wrap gap-3">
                  <DenButton variant="secondary" onClick={() => setEditing(true)} disabled={!access.canManageSso}>Edit connection</DenButton>
                  {connection.status === "enabled" ? (
                    <DenButton variant="secondary" onClick={() => void handleDisable()} disabled={disabling || !access.canManageSso}>{disabling ? "Disabling..." : "Disable connection"}</DenButton>
                  ) : connection.testStatus === "succeeded" ? (
                    <DenButton variant="primary" icon={CheckCircle2} onClick={() => void handleEnable()} disabled={enabling || !access.canManageSso}>{enabling ? "Enabling..." : "Enable connection"}</DenButton>
                  ) : (
                    <DenButton variant="primary" icon={Shield} onClick={handleOpenTestDialog} disabled={!access.canManageSso || !connection.domainVerified}>Enable Config</DenButton>
                  )}
                  <DenButton variant="secondary" icon={Trash2} onClick={() => void handleDelete()} disabled={deleting || !access.canManageSso}>{deleting ? "Deleting..." : "Delete connection"}</DenButton>
                </div>
              ) : null}
            </div>

            {!connection && !busy ? <p className="mt-4 text-[14px] text-gray-500">No SSO connection configured yet.</p> : null}

            {connection ? (
              <div className="mt-5 space-y-4">
                {!connection.domainVerified ? (
                  <section id="sso-domain-verification" data-testid="sso-domain-verification" className="scroll-mt-6 overflow-hidden rounded-[24px] border border-[var(--dls-border)] bg-[var(--dls-surface)] text-[14px] text-[var(--dls-text-primary)]">
                    <div className="flex flex-col gap-4 border-b border-[var(--dls-border)] bg-[var(--dls-hover)] px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 rounded-full bg-amber-900 p-2 text-amber-50"><ShieldAlert size={18} aria-hidden="true" /></span>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-[16px] font-semibold tracking-[-0.02em]">Verify your domain first</p>
                            <span className="rounded-full border border-amber-300 bg-white/80 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-800">Pending verification</span>
                          </div>
                          <p className="mt-1 max-w-2xl leading-6 text-[var(--dls-text-secondary)]">
                            This connection stays off until this DNS check proves that your workspace controls <strong>{connection.domains.join(", ") || connection.domain}</strong>.{connection.domains.length > 1 ? " Add the same TXT value at each domain's record name." : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <DenButton variant="secondary" icon={KeyRound} onClick={() => void handleRequestDomainToken()} disabled={requestingDomainToken || !access.canManageSso}>
                          {requestingDomainToken ? "Requesting..." : "Request token"}
                        </DenButton>
                        <DenButton variant="primary" icon={RefreshCw} onClick={() => void handleVerifyDomain()} disabled={verifyingDomain || !access.canManageSso || !domainVerificationToken}>
                          {verifyingDomain ? "Verifying..." : "Verify domain"}
                        </DenButton>
                      </div>
                    </div>

                    <div className="grid gap-px bg-[var(--dls-border)] md:grid-cols-2">
                      {[
                        { label: "Record type", value: "TXT", key: "domain-record-type" },
                        { label: "Host / name", value: connection.domainVerificationHost, key: "domain-record-host" },
                        ...(connection.domainVerificationDnsNames.length > 1
                          ? connection.domainVerificationDnsNames.map((record) => ({ label: `Full DNS name for ${record.domain}`, value: record.dnsName, key: `domain-record-name-${record.domain}` }))
                          : [{ label: "Full DNS name", value: connection.domainVerificationDnsName, key: "domain-record-name" }]),
                        { label: "Value", value: domainVerificationToken, key: "domain-token" },
                      ].map((record) => (
                        <div key={record.key} className="bg-[var(--dls-surface)] px-5 py-4">
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--dls-text-secondary)]">{record.label}</p>
                            {record.value ? (
                              <button type="button" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--dls-text-primary)] transition hover:bg-[var(--dls-active)]" onClick={() => void copyValue(record.value, record.key)}>
                                <Copy size={13} aria-hidden="true" /> {copiedValue === record.key ? "Copied" : "Copy"}
                              </button>
                            ) : null}
                          </div>
                          <code className="block break-all text-[13px] leading-6 text-gray-800">{record.value ?? "Request a token to reveal the TXT value"}</code>
                        </div>
                      ))}
                    </div>

                    <div className="grid gap-3 px-5 py-4 text-[13px] leading-5 text-[var(--dls-text-secondary)] sm:grid-cols-2">
                      <p><strong className="text-[var(--dls-text-primary)]">DNS providers differ:</strong> use the host value when your provider appends the domain automatically; otherwise use the full DNS name.</p>
                      <p><strong className="text-[var(--dls-text-primary)]">One-time proof:</strong> tokens expire after seven days. After verification succeeds, you may remove the TXT record. Changing the domain requires verification again.</p>
                    </div>
                  </section>
                ) : (
                  <div className="flex items-start gap-3 rounded-[20px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-[14px] text-emerald-900">
                    <CheckCircle2 className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
                    <div>
                      <p className="font-semibold">{connection.domains.length > 1 ? "Domains verified" : "Domain verified"}{connection.status === "enabled" ? " · Connection enabled" : ""}</p>
                      <p className="mt-1 text-emerald-800">{connection.status === "enabled" ? "This tested configuration is active." : "The configuration is still disabled. Test it before enabling SSO."} The DNS TXT record was a one-time proof and may now be removed.</p>
                    </div>
                  </div>
                )}

                <div data-testid="sso-provider-setup" className="space-y-4">
                  {[
                    ["Sign-in URL", connection.signInUrl, "signin"],
                    ["Redirect URL", connection.redirectUrl, "redirect"],
                    ["ACS URL", connection.acsUrl, "acs"],
                    ["Metadata URL", connection.metadataUrl, "metadata"],
                  ].map(([label, value, key]) => (
                    <div key={key as string} className="rounded-[20px] border border-gray-200 bg-gray-50 p-4">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-gray-500">{label as string}</p>
                        <DenButton variant="secondary" icon={Copy} onClick={() => void copyValue((value as string | null) ?? null, key as string)} disabled={!value}>{copiedValue === key ? "Copied" : "Copy"}</DenButton>
                      </div>
                      <code className="block break-all text-[13px] leading-6 text-gray-700">{(value as string | null) ?? "Not applicable"}</code>
                    </div>
                  ))}
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-[20px] border border-gray-200 bg-gray-50 p-4 text-[14px] text-gray-700">
                    <p className="font-medium text-gray-900">Provider</p>
                    <p className="mt-2">{connection.providerId}</p>
                    <p className="mt-2">{connection.kind.toUpperCase()} · {connection.domains.join(", ") || connection.domain}</p>
                    <p className="mt-2">Domain verified: {connection.domainVerified ? "Yes" : "No"}</p>
                  </div>
                  <div className="rounded-[20px] border border-gray-200 bg-gray-50 p-4 text-[14px] text-gray-700">
                    <p className="font-medium text-gray-900">Status</p>
                    <p className="mt-2">{connection.status === "enabled" ? "Enabled" : "Saved · disabled"}</p>
                    <p className="mt-2">Test: {connection.testStatus === "succeeded" ? "Successful" : connection.testStatus === "failed" ? "Failed" : connection.testStatus === "testing" ? "In progress" : "Not tested"}</p>
                    <p className="mt-2">Last tested: {formatDateTime(connection.lastTestedAt)}</p>
                    <p className="mt-2">Updated: {formatDateTime(connection.updatedAt)}</p>
                  </div>
                </div>

                {connection.testStatus === "failed" && connection.lastError ? <div data-testid="sso-test-failure" className="rounded-[20px] border border-red-200 bg-red-50 p-4 text-[14px] text-red-700">{connection.lastError}</div> : null}
              </div>
            ) : null}
          </div>
          )}

          {testDialogOpen && connection ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4 py-6 backdrop-blur-[2px]">
              <div role="dialog" aria-modal="true" aria-labelledby="sso-test-dialog-title" data-testid="sso-test-dialog" className="w-full max-w-[480px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_28px_80px_-36px_rgba(15,23,42,0.6)]">
                <div className="relative border-b border-slate-100 bg-slate-50/70 px-6 pb-5 pt-6">
                  <button type="button" aria-label="Close SSO test" className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white hover:text-slate-700" onClick={closeTestDialog}>
                    <X size={17} aria-hidden="true" />
                  </button>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Enable configuration</p>
                  <h2 id="sso-test-dialog-title" className="mt-2 text-[22px] font-semibold tracking-[-0.03em] text-slate-950">Test SSO before enabling it</h2>
                  <p className="mt-2 pr-8 text-[14px] leading-6 text-slate-600">A separate window performs real authentication with the saved {connection.kind.toUpperCase()} configuration. SSO stays disabled until you explicitly enable it.</p>
                </div>
                <div className="space-y-4 px-6 py-5">
                  {connection.testStatus === "testing" ? (
                    <div className="flex items-start gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-[14px] text-violet-900">
                      <LoaderCircle className="mt-0.5 animate-spin" size={18} aria-hidden="true" />
                      <div><p className="font-semibold">Authentication test in progress</p><p className="mt-1 text-violet-800">Finish signing in in the new window. This window will update automatically.</p></div>
                    </div>
                  ) : connection.testStatus === "succeeded" ? (
                    <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[14px] text-emerald-900">
                      <CheckCircle2 className="mt-0.5" size={18} aria-hidden="true" />
                      <div><p className="font-semibold">Authentication test successful</p><p className="mt-1 text-emerald-800">The exact saved configuration passed. SSO is still disabled.</p></div>
                    </div>
                  ) : connection.testStatus === "failed" ? (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-800">
                      <p className="font-semibold">Authentication test failed</p>
                      <p className="mt-1">{connection.lastError ?? "Check the provider configuration and try again."}</p>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[14px] text-slate-700">The saved configuration has not been tested.</div>
                  )}
                  <div className="flex flex-wrap justify-end gap-3">
                    <DenButton variant="secondary" onClick={closeTestDialog}>Close</DenButton>
                    {connection.testStatus === "succeeded" ? (
                      <DenButton variant="primary" icon={CheckCircle2} onClick={() => void handleEnable()} disabled={enabling}>{enabling ? "Enabling..." : "Enable SSO"}</DenButton>
                    ) : (
                      <DenButton variant="primary" icon={Shield} onClick={() => void handleStartTest()} disabled={startingTest || connection.testStatus === "testing"}>
                        {startingTest ? "Opening SSO login..." : connection.testStatus === "failed" ? "Try SSO login again" : "SSO Login"}
                      </DenButton>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
    </>
  );
}

