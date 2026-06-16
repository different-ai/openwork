"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { getErrorMessage, getOrgLimitError, getOrgPaymentRequiredError, getRequestError, isReauthRequiredError, requestJson } from "../../_lib/den-flow";
import { ReauthDialog } from "../../_components/reauth-dialog";
import {
  type DenOrgContext,
  type DenOrgSummary,
  getOrgDashboardRoute,
  parseOrgContextPayload,
  parseOrgListPayload,
} from "../../_lib/den-org";

type OrgDashboardContextValue = {
  orgSlug: string | null;
  orgId: string | null;
  orgDirectory: DenOrgSummary[];
  activeOrg: DenOrgSummary | null;
  orgContext: DenOrgContext | null;
  orgBusy: boolean;
  orgError: string | null;
  mutationBusy: string | null;
  refreshOrgData: () => Promise<void>;
  createOrganization: (name: string) => Promise<void>;
  updateOrganizationName: (name: string) => Promise<void>;
  updateOrganizationSettings: (input: { name?: string; allowedEmailDomains?: string[] | null; allowedDesktopVersions?: string[] | null; requireSso?: boolean }) => Promise<void>;
  switchOrganization: (slug: string) => void;
  inviteMember: (input: { email: string; role: string }) => Promise<void>;
  startSeatCheckout: () => Promise<void>;
  cancelInvitation: (invitationId: string) => Promise<void>;
  updateMemberRole: (memberId: string, role: string) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
  createTeam: (input: { name: string; memberIds: string[] }) => Promise<void>;
  updateTeam: (teamId: string, input: { name?: string; memberIds?: string[] }) => Promise<void>;
  deleteTeam: (teamId: string) => Promise<void>;
  createRole: (input: { roleName: string; permission: Record<string, string[]> }) => Promise<void>;
  updateRole: (roleId: string, input: { roleName?: string; permission?: Record<string, string[]> }) => Promise<void>;
  deleteRole: (roleId: string) => Promise<void>;
  runReauthableAction: (label: string, action: () => Promise<void>) => Promise<void>;
};

type PendingReauthMutation = {
  label: string;
  action: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const OrgDashboardContext = createContext<OrgDashboardContextValue | null>(null);

export function OrgDashboardProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, sessionHydrated, signOut, refreshWorkers, workersLoadedOnce } = useDenFlow();
  const [orgDirectory, setOrgDirectory] = useState<DenOrgSummary[]>([]);
  const [orgContext, setOrgContext] = useState<DenOrgContext | null>(null);
  const [orgBusy, setOrgBusy] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);
  const [pendingReauthMutation, setPendingReauthMutation] = useState<PendingReauthMutation | null>(null);

  const activeOrg = useMemo(
    () =>
      orgDirectory.find((entry) => entry.isActive) ??
      orgDirectory[0] ??
      null,
    [orgDirectory],
  );

  const activeOrgId = activeOrg?.id ?? orgContext?.organization.id ?? null;

  function ensureActiveOrganizationSelected() {
    if (!activeOrgId) {
      throw new Error("Organization not found.");
    }
  }

  async function loadOrgDirectory() {
    const { response, payload } = await requestJson("/v1/me/orgs", { method: "GET" }, 12000);
    if (!response.ok) {
      throw new Error(getErrorMessage(payload, `Failed to load organizations (${response.status}).`));
    }

    return parseOrgListPayload(payload);
  }

  async function setActiveOrganization(input: { organizationId?: string | null; organizationSlug?: string | null }) {
    const { response, payload } = await requestJson(
      "/api/auth/organization/set-active",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      12000,
    );

    if (!response.ok) {
      throw new Error(getErrorMessage(payload, `Failed to switch organization (${response.status}).`));
    }
  }

  async function loadOrgContext() {
    const { response, payload } = await requestJson("/v1/org", { method: "GET" }, 12000);
    if (!response.ok) {
      throw new Error(getErrorMessage(payload, `Failed to load organization (${response.status}).`));
    }

    const parsed = parseOrgContextPayload(payload);
    if (!parsed) {
      throw new Error("Organization context response was incomplete.");
    }

    return parsed;
  }

  async function refreshOrgData() {
    if (!user) {
      setOrgDirectory([]);
      setOrgContext(null);
      setOrgError(null);
      return;
    }

    setOrgBusy(true);
    setOrgError(null);

    try {
      let directoryPayload = await loadOrgDirectory();
      const targetOrg = directoryPayload.orgs.find((entry) => entry.isActive) ?? directoryPayload.orgs[0] ?? null;

      if (!targetOrg) {
        setOrgDirectory([]);
        setOrgContext(null);
        router.replace("/organization");
        return;
      }

      if (!targetOrg.isActive) {
        await setActiveOrganization({ organizationId: targetOrg.id });
        directoryPayload = await loadOrgDirectory();
      }

      const context = await loadOrgContext();

      setOrgDirectory(directoryPayload.orgs.map((entry) => ({ ...entry, isActive: entry.id === context.organization.id })));
      setOrgContext(context);
      await refreshWorkers({ keepSelection: false, quiet: workersLoadedOnce });
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : "Failed to load organization details.");
    } finally {
      setOrgBusy(false);
    }
  }

  async function executeReauthableAction(label: string, action: () => Promise<void>) {
    setMutationBusy(label);
    setOrgError(null);
    try {
      await action();
    } finally {
      setMutationBusy(null);
    }
  }

  async function runReauthableAction(label: string, action: () => Promise<void>) {
    try {
      await executeReauthableAction(label, action);
    } catch (error) {
      if (!isReauthRequiredError(error)) {
        throw error;
      }

      await new Promise<void>((resolve, reject) => {
        setPendingReauthMutation({ label, action, resolve, reject });
      });
    }
  }

  async function runMutation(label: string, action: () => Promise<void>) {
    await runReauthableAction(label, async () => {
      await action();
      await refreshOrgData();
    });
  }

  function cancelReauth() {
    const pending = pendingReauthMutation;
    setPendingReauthMutation(null);
    pending?.reject(new Error("Sign in again before continuing."));
  }

  async function retryReauthMutation() {
    const pending = pendingReauthMutation;
    if (!pending) {
      return;
    }

    setPendingReauthMutation(null);
    try {
      await executeReauthableAction(pending.label, pending.action);
      pending.resolve();
    } catch (error) {
      pending.reject(error);
    }
  }

  async function createOrganization(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Enter an organization name.");
    }

    setMutationBusy("create-organization");
    setOrgError(null);
    try {
      const { response, payload } = await requestJson(
        "/v1/org",
        {
          method: "POST",
          body: JSON.stringify({ name: trimmed }),
        },
        12000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to create organization (${response.status}).`));
      }

      const organization =
        typeof payload === "object" && payload && "organization" in payload && payload.organization && typeof payload.organization === "object"
          ? payload.organization as { slug?: unknown }
          : null;
      const nextSlug = typeof organization?.slug === "string" ? organization.slug : null;

      if (!nextSlug) {
        throw new Error("Organization was created, but no slug was returned.");
      }

      router.push(getOrgDashboardRoute(nextSlug));
    } finally {
      setMutationBusy(null);
    }
  }

  function switchOrganization(nextSlug: string) {
    const targetOrg = orgDirectory.find((entry) => entry.slug === nextSlug) ?? null;
    if (!targetOrg) {
      return;
    }

    void (async () => {
      setMutationBusy("switch-organization");
      setOrgError(null);

      try {
        await setActiveOrganization({ organizationId: targetOrg.id });
        const context = await loadOrgContext();
        setOrgDirectory((current) => current.map((entry) => ({ ...entry, isActive: entry.id === context.organization.id })));
        setOrgContext(context);
        await refreshWorkers({ keepSelection: false, quiet: workersLoadedOnce });

        router.refresh();
      } catch (error) {
        setOrgError(error instanceof Error ? error.message : "Failed to switch organization.");
      } finally {
        setMutationBusy(null);
      }
    })();
  }

  async function updateOrganizationName(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Enter an organization name.");
    }

    await updateOrganizationSettings({ name: trimmed });
  }

  async function updateOrganizationSettings(input: { name?: string; allowedEmailDomains?: string[] | null; allowedDesktopVersions?: string[] | null; requireSso?: boolean }) {
    const body: { name?: string; allowedEmailDomains?: string[] | null; allowedDesktopVersions?: string[] | null; requireSso?: boolean } = {};
    if (typeof input.name === "string") {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new Error("Enter an organization name.");
      }
      body.name = trimmed;
    }
    if (input.allowedEmailDomains !== undefined) {
      body.allowedEmailDomains = input.allowedEmailDomains;
    }
    if (input.allowedDesktopVersions !== undefined) {
      body.allowedDesktopVersions = input.allowedDesktopVersions;
    }
    if (input.requireSso !== undefined) {
      body.requireSso = input.requireSso;
    }

    await runMutation("update-organization-settings", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        "/v1/org",
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
        12000,
      );

      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to update organization (${response.status}).`);
      }
    });
  }

  async function inviteMember(input: { email: string; role: string }) {
    await runMutation("invite-member", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        "/v1/invitations",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        12000,
      );

      if (!response.ok) {
        const paymentRequiredError = getOrgPaymentRequiredError(payload);
        if (paymentRequiredError) {
          throw paymentRequiredError;
        }

        const limitError = getOrgLimitError(payload);
        if (limitError) {
          throw limitError;
        }
        throw getRequestError(payload, response, `Failed to invite member (${response.status}).`);
      }
    });
  }

  async function startSeatCheckout() {
    setMutationBusy("seat-checkout");
    setOrgError(null);
    try {
      await runReauthableAction("seat-checkout", async () => {
        ensureActiveOrganizationSelected();
        const { response, payload } = await requestJson(
          "/v1/billing/stripe/checkout",
          {
            method: "POST",
            body: JSON.stringify({ type: "seat" }),
          },
          12000,
        );

        if (!response.ok) {
          throw getRequestError(payload, response, `Seat billing checkout failed (${response.status}).`);
        }

        const url = payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string"
          ? payload.url
          : null;
        if (!url) {
          throw new Error("Seat billing checkout response did not include a URL.");
        }

        window.location.href = url;
      });
    } finally {
      setMutationBusy(null);
    }
  }

  async function cancelInvitation(invitationId: string) {
    await runMutation("cancel-invitation", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        `/v1/invitations/${encodeURIComponent(invitationId)}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
        12000,
      );

      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to cancel invitation (${response.status}).`);
      }
    });
  }

  async function updateMemberRole(memberId: string, role: string) {
    await runMutation("update-member-role", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        `/v1/members/${encodeURIComponent(memberId)}/role`,
        {
          method: "POST",
          body: JSON.stringify({ role }),
        },
        12000,
      );

      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to update member (${response.status}).`);
      }
    });
  }

  async function removeMember(memberId: string) {
    await runMutation("remove-member", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        `/v1/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE" },
        12000,
      );

      if (response.status !== 204 && !response.ok) {
        throw getRequestError(payload, response, `Failed to remove member (${response.status}).`);
      }
    });
  }

  async function createRole(input: { roleName: string; permission: Record<string, string[]> }) {
    await runMutation("create-role", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        "/v1/roles",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        12000,
      );

      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to create role (${response.status}).`);
      }
    });
  }

  async function createTeam(input: { name: string; memberIds: string[] }) {
    await runMutation("create-team", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        "/v1/teams",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        12000,
      );

      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to create team (${response.status}).`);
      }
    });
  }

  async function updateTeam(teamId: string, input: { name?: string; memberIds?: string[] }) {
    await runMutation("update-team", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        `/v1/teams/${encodeURIComponent(teamId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
        12000,
      );

      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to update team (${response.status}).`);
      }
    });
  }

  async function deleteTeam(teamId: string) {
    await runMutation("delete-team", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        `/v1/teams/${encodeURIComponent(teamId)}`,
        { method: "DELETE" },
        12000,
      );

      if (response.status !== 204 && !response.ok) {
        throw getRequestError(payload, response, `Failed to delete team (${response.status}).`);
      }
    });
  }

  async function updateRole(roleId: string, input: { roleName?: string; permission?: Record<string, string[]> }) {
    await runMutation("update-role", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        `/v1/roles/${encodeURIComponent(roleId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
        12000,
      );

      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to update role (${response.status}).`);
      }
    });
  }

  async function deleteRole(roleId: string) {
    await runMutation("delete-role", async () => {
      ensureActiveOrganizationSelected();
      const { response, payload } = await requestJson(
        `/v1/roles/${encodeURIComponent(roleId)}`,
        { method: "DELETE" },
        12000,
      );

      if (response.status !== 204 && !response.ok) {
        throw getRequestError(payload, response, `Failed to delete role (${response.status}).`);
      }
    });
  }

  useEffect(() => {
    if (!sessionHydrated) {
      return;
    }

    if (!user) {
      void signOut();
      router.replace("/");
      return;
    }

    void refreshOrgData();
  }, [router, sessionHydrated, user?.id]);

  const value: OrgDashboardContextValue = {
    orgSlug: activeOrg?.slug ?? null,
    orgId: activeOrgId,
    orgDirectory,
    activeOrg,
    orgContext,
    orgBusy,
    orgError,
    mutationBusy,
    refreshOrgData,
    createOrganization,
    updateOrganizationName,
    updateOrganizationSettings,
      switchOrganization,
      inviteMember,
      startSeatCheckout,
      cancelInvitation,
    updateMemberRole,
    removeMember,
    createTeam,
    updateTeam,
    deleteTeam,
    createRole,
    updateRole,
    deleteRole,
    runReauthableAction,
  };

  return (
    <OrgDashboardContext.Provider value={value}>
      {children}
      <ReauthDialog
        open={Boolean(pendingReauthMutation)}
        user={user}
        orgContext={orgContext}
        onCancel={cancelReauth}
        onVerified={retryReauthMutation}
      />
    </OrgDashboardContext.Provider>
  );
}

export function useOrgDashboard() {
  const value = useContext(OrgDashboardContext);
  if (!value) {
    throw new Error("useOrgDashboard must be used within OrgDashboardProvider.");
  }
  return value;
}
