"use client";

import { Copy, RefreshCw, Shield, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import {
  type DenOrgScimConnection,
  getOrgAccessFlags,
  parseOrgScimPayload,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

function formatDateTime(value: string | null) {
  if (!value) {
    return "Not configured";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not configured";
  }

  return date.toLocaleString();
}

export function ScimScreen() {
  const { orgId, orgContext } = useOrgDashboard();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [connection, setConnection] = useState<DenOrgScimConnection | null>(null);
  const [visibleToken, setVisibleToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedValue, setCopiedValue] = useState<"base-url" | "token" | null>(null);

  const access = useMemo(
    () =>
      getOrgAccessFlags(
        orgContext?.currentMember.role ?? "member",
        orgContext?.currentMember.isOwner ?? false,
      ),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role],
  );

  async function loadScimConfig(isCurrent = () => true) {
    if (!orgId || !access.canManageScim) {
      if (isCurrent()) {
        setBaseUrl(null);
        setConnection(null);
      }
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(
        "/v1/scim",
        { method: "GET" },
        12000,
      );

      if (!response.ok) {
        throw new Error(
          getErrorMessage(payload, `Failed to load SCIM settings (${response.status}).`),
        );
      }

      const parsed = parseOrgScimPayload(payload);
      if (isCurrent()) {
        setBaseUrl(parsed.baseUrl);
        setConnection(parsed.connection);
      }
    } catch (nextError) {
      if (isCurrent()) {
        setError(
          nextError instanceof Error ? nextError.message : "Failed to load SCIM settings.",
        );
      }
    } finally {
      if (isCurrent()) {
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    let active = true;
    void loadScimConfig(() => active);
    return () => {
      active = false;
    };
  }, [orgId, access.canManageScim]);

  useEffect(() => {
    if (!copiedValue) {
      return;
    }

    const timeout = window.setTimeout(() => setCopiedValue(null), 1500);
    return () => window.clearTimeout(timeout);
  }, [copiedValue]);

  async function copyValue(value: string | null, kind: "base-url" | "token") {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(kind);
    } catch {
      setError(`Could not copy the ${kind === "token" ? "SCIM token" : "SCIM base URL"}.`);
    }
  }

  async function handleRotateToken() {
    if (!orgId) {
      setError("Organization not found.");
      return;
    }

    setRotating(true);
    setError(null);
    setVisibleToken(null);
    try {
      const { response, payload } = await requestJson(
        "/v1/scim/token",
        { method: "POST", body: JSON.stringify({}) },
        12000,
      );

      if (!response.ok) {
        throw new Error(
          getErrorMessage(payload, `Failed to rotate SCIM token (${response.status}).`),
        );
      }

      const parsed = parseOrgScimPayload(payload);
      if (!parsed.baseUrl || !parsed.connection || !parsed.scimToken) {
        throw new Error("SCIM token rotation succeeded, but the response was incomplete.");
      }

      setBaseUrl(parsed.baseUrl);
      setConnection(parsed.connection);
      setVisibleToken(parsed.scimToken);
      setCopiedValue(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to rotate SCIM token.",
      );
    } finally {
      setRotating(false);
    }
  }

  async function handleDeleteConnection() {
    if (
      !orgId ||
      !window.confirm(
        "Delete this SCIM connection? The current bearer token will stop working immediately.",
      )
    ) {
      return;
    }

    setDeleting(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(
        "/v1/scim",
        { method: "DELETE" },
        12000,
      );

      if (response.status !== 204 && !response.ok) {
        throw new Error(
          getErrorMessage(payload, `Failed to delete SCIM connection (${response.status}).`),
        );
      }

      setConnection(null);
      setVisibleToken(null);
      setCopiedValue(null);
      await loadScimConfig();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to delete SCIM connection.",
      );
    } finally {
      setDeleting(false);
    }
  }

  if (!orgContext) {
    return (
      <DashboardPageTemplate
        icon={Shield}
        badgeLabel="Admin"
        title="SCIM"
        description="Provision organization members from your identity provider with an org-scoped SCIM connector."
        colors={["#ECFEFF", "#155E75", "#06B6D4", "#A5F3FC"]}
      >
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading organization details...
        </div>
      </DashboardPageTemplate>
    );
  }

  return (
    <DashboardPageTemplate
      icon={Shield}
      badgeLabel="Admin"
      title="SCIM"
      description="Create one SCIM connector per workspace, then give your identity provider the base URL and bearer token shown here."
      colors={["#ECFEFF", "#155E75", "#06B6D4", "#A5F3FC"]}
    >
      {!access.canManageScim ? (
        <div className="rounded-[28px] border border-amber-200 bg-amber-50 px-6 py-5 text-[14px] text-amber-900">
          Only organization owners and admins can manage SCIM.
        </div>
      ) : (
        <>
          {error ? (
            <div className="mb-6 rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[14px] text-red-700">
              {error}
            </div>
          ) : null}

          <div className="mb-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[16px] font-semibold tracking-[-0.03em] text-gray-900">
                  SCIM base URL
                </p>
                <p className="mt-1 text-[14px] leading-6 text-gray-500">
                  Use this URL when your identity provider asks for the SCIM endpoint.
                </p>
                <p className="mt-2 text-[13px] leading-6 text-gray-500">
                  SCIM currently supports User provisioning and deprovisioning. SCIM Groups are not enabled yet.
                </p>
              </div>
              <DenButton
                variant="secondary"
                icon={Copy}
                onClick={() => void copyValue(baseUrl, "base-url")}
                disabled={!baseUrl}
              >
                {copiedValue === "base-url" ? "Copied" : "Copy URL"}
              </DenButton>
            </div>

            <div className="mt-5 rounded-[20px] border border-gray-200 bg-gray-50 p-4">
              <code className="block break-all text-[13px] leading-6 text-gray-700">
                {baseUrl ?? (busy ? "Loading..." : "Not available")}
              </code>
            </div>
          </div>

          <div className="mb-6 rounded-[30px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.22)]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[16px] font-semibold tracking-[-0.03em] text-gray-900">
                  Connector token
                </p>
                <p className="mt-1 text-[14px] leading-6 text-gray-500">
                  {connection
                    ? "Rotate the bearer token whenever your identity provider needs a fresh secret."
                    : "Create the workspace SCIM connector and generate its first bearer token."}
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <DenButton icon={RefreshCw} onClick={() => void handleRotateToken()} loading={rotating}>
                  {connection ? "Rotate token" : "Create connector"}
                </DenButton>
                {connection ? (
                  <DenButton
                    variant="destructive"
                    icon={Trash2}
                    onClick={() => void handleDeleteConnection()}
                    loading={deleting}
                  >
                    Delete connector
                  </DenButton>
                ) : null}
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-[20px] border border-gray-200 bg-gray-50 p-4">
                <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-gray-500">
                  Status
                </p>
                <p className="mt-2 text-[15px] font-medium text-gray-900">
                  {busy ? "Loading..." : connection ? "Connected" : "Not configured"}
                </p>
                <p className="mt-2 text-[13px] leading-6 text-gray-500">
                  Last rotated {formatDateTime(connection?.updatedAt ?? null)}
                </p>
                {connection ? (
                  <p className="mt-2 break-all text-[12px] text-gray-400">
                    Internal provider id: {connection.providerId}
                  </p>
                ) : null}
              </div>

              <div className="rounded-[20px] border border-cyan-100 bg-cyan-50 p-4 text-[13px] leading-6 text-cyan-900">
                SCIM deprovisioning removes workspace access and the SCIM provider account, but it does not blindly delete the global OpenWork user record.
              </div>
            </div>

            {visibleToken ? (
              <div className="mt-5 rounded-[24px] bg-[#0f172a] p-6 text-white">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-[16px] font-semibold tracking-[-0.03em]">
                      Your SCIM bearer token is ready
                    </p>
                    <p className="mt-1 text-[14px] leading-6 text-slate-300">
                      Copy it now. This value is only shown immediately after creation or rotation.
                    </p>
                  </div>
                  <DenButton
                    variant="secondary"
                    icon={Copy}
                    onClick={() => void copyValue(visibleToken, "token")}
                  >
                    {copiedValue === "token" ? "Copied" : "Copy token"}
                  </DenButton>
                </div>

                <div className="mt-5 rounded-[20px] border border-white/10 bg-white/5 p-4">
                  <code className="block break-all text-[13px] leading-6 text-cyan-200">
                    {visibleToken}
                  </code>
                </div>
              </div>
            ) : null}
          </div>
        </>
      )}
    </DashboardPageTemplate>
  );
}
