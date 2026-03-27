"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import {
  type DenOrgContext,
  type DenOrgSummary,
  getOrgDashboardRoute,
  parseOrgContextPayload,
  parseOrgListPayload,
} from "../../../../_lib/den-org";

type OrgDashboardContextValue = {
  orgSlug: string;
  orgDirectory: DenOrgSummary[];
  activeOrg: DenOrgSummary | null;
  orgContext: DenOrgContext | null;
  orgBusy: boolean;
  orgError: string | null;
  mutationBusy: string | null;
  refreshOrgData: () => Promise<void>;
  createOrganization: (name: string) => Promise<void>;
  switchOrganization: (slug: string) => void;
  inviteMember: (input: { email: string; role: string }) => Promise<void>;
  cancelInvitation: (invitationId: string) => Promise<void>;
  updateMemberRole: (memberId: string, role: string) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
  createRole: (input: { roleName: string; permission: Record<string, string[]> }) => Promise<void>;
  updateRole: (roleId: string, input: { roleName?: string; permission?: Record<string, string[]> }) => Promise<void>;
  deleteRole: (roleId: string) => Promise<void>;
};

const OrgDashboardContext = createContext<OrgDashboardContextValue | null>(null);

export function OrgDashboardProvider({
  orgSlug,
  children,
}: {
  orgSlug: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { user, sessionHydrated, signOut, refreshWorkers, workersLoadedOnce } = useDenFlow();
  const [orgDirectory, setOrgDirectory] = useState<DenOrgSummary[]>([]);
  const [orgContext, setOrgContext] = useState<DenOrgContext | null>(null);
  const [orgBusy, setOrgBusy] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);

  const activeOrg = useMemo(
    () => orgDirectory.find((entry) => entry.slug === orgSlug) ?? orgDirectory.find((entry) => entry.isActive) ?? null,
    [orgDirectory, orgSlug],
  );

  async function loadOrgDirectory() {
    const { response, payload } = await requestJson("/v1/me/orgs", { method: "GET" }, 12000);
    if (!response.ok) {
      throw new Error(getErrorMessage(payload, `Failed to load organizations (${response.status}).`));
    }

    return parseOrgListPayload(payload).orgs;
  }

  async function loadOrgContext(targetOrgSlug: string) {
    const { response, payload } = await requestJson(`/v1/orgs/${encodeURIComponent(targetOrgSlug)}/context`, { method: "GET" }, 12000);
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
      const [directory, context] = await Promise.all([
        loadOrgDirectory(),
        loadOrgContext(orgSlug),
      ]);

      setOrgDirectory(directory.map((entry) => ({ ...entry, isActive: entry.slug === context.organization.slug })));
      setOrgContext(context);
      await refreshWorkers({ keepSelection: false, quiet: workersLoadedOnce });
    } catch (error) {
      setOrgError(error instanceof Error ? error.message : "Failed to load organization details.");
    } finally {
      setOrgBusy(false);
    }
  }

  async function runMutation(label: string, action: () => Promise<void>) {
    setMutationBusy(label);
    setOrgError(null);
    try {
      await action();
      await refreshOrgData();
    } finally {
      setMutationBusy(null);
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
        "/v1/orgs",
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
    router.push(getOrgDashboardRoute(nextSlug));
  }

  async function inviteMember(input: { email: string; role: string }) {
    await runMutation("invite-member", async () => {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/invitations`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        12000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to invite member (${response.status}).`));
      }
    });
  }

  async function cancelInvitation(invitationId: string) {
    await runMutation("cancel-invitation", async () => {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/invitations/${encodeURIComponent(invitationId)}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
        12000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to cancel invitation (${response.status}).`));
      }
    });
  }

  async function updateMemberRole(memberId: string, role: string) {
    await runMutation("update-member-role", async () => {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/members/${encodeURIComponent(memberId)}/role`,
        {
          method: "POST",
          body: JSON.stringify({ role }),
        },
        12000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to update member (${response.status}).`));
      }
    });
  }

  async function removeMember(memberId: string) {
    await runMutation("remove-member", async () => {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE" },
        12000,
      );

      if (response.status !== 204 && !response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to remove member (${response.status}).`));
      }
    });
  }

  async function createRole(input: { roleName: string; permission: Record<string, string[]> }) {
    await runMutation("create-role", async () => {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/roles`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        12000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to create role (${response.status}).`));
      }
    });
  }

  async function updateRole(roleId: string, input: { roleName?: string; permission?: Record<string, string[]> }) {
    await runMutation("update-role", async () => {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/roles/${encodeURIComponent(roleId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
        12000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to update role (${response.status}).`));
      }
    });
  }

  async function deleteRole(roleId: string) {
    await runMutation("delete-role", async () => {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/roles/${encodeURIComponent(roleId)}`,
        { method: "DELETE" },
        12000,
      );

      if (response.status !== 204 && !response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to delete role (${response.status}).`));
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
  }, [orgSlug, router, sessionHydrated, user?.id]);

  const value: OrgDashboardContextValue = {
    orgSlug,
    orgDirectory,
    activeOrg,
    orgContext,
    orgBusy,
    orgError,
    mutationBusy,
    refreshOrgData,
    createOrganization,
    switchOrganization,
    inviteMember,
    cancelInvitation,
    updateMemberRole,
    removeMember,
    createRole,
    updateRole,
    deleteRole,
  };

  return <OrgDashboardContext.Provider value={value}>{children}</OrgDashboardContext.Provider>;
}

export function useOrgDashboard() {
  const value = useContext(OrgDashboardContext);
  if (!value) {
    throw new Error("useOrgDashboard must be used within OrgDashboardProvider.");
  }
  return value;
}
