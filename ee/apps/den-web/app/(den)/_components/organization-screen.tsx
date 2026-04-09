"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LogOut, Settings } from "lucide-react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { type DenOrgSummary, formatRoleLabel, getOrgDashboardRoute, parseOrgListPayload } from "../_lib/den-org";
import { useDenFlow } from "../_providers/den-flow-provider";

type SettingsTab = "profile" | "organizations";

const PENDING_ORG_DRAFT_STORAGE_KEY = "openwork-den-pending-org-draft";

function readPendingOrgDraft(userEmail: string | null | undefined) {
  if (typeof window === "undefined" || !userEmail) {
    return null;
  }

  const raw = window.localStorage.getItem(PENDING_ORG_DRAFT_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { name?: unknown; email?: unknown };
    if (typeof parsed.name !== "string" || typeof parsed.email !== "string") {
      return null;
    }

    return parsed.email === userEmail ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

function writePendingOrgDraft(name: string, userEmail: string | null | undefined) {
  if (typeof window === "undefined" || !userEmail) {
    return;
  }

  window.localStorage.setItem(
    PENDING_ORG_DRAFT_STORAGE_KEY,
    JSON.stringify({
      name,
      email: userEmail,
    }),
  );
}

function clearPendingOrgDraft() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(PENDING_ORG_DRAFT_STORAGE_KEY);
}

export function OrganizationScreen() {
  const router = useRouter();
  const { user, sessionHydrated, signOut, billingSummary } = useDenFlow();
  const [orgs, setOrgs] = useState<DenOrgSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("organizations");
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [hasPendingOrgDraft, setHasPendingOrgDraft] = useState(false);

  const userDisplayName = useMemo(() => {
    const trimmedName = user?.name?.trim();
    if (trimmedName) return trimmedName;
    const emailLocalPart = user?.email?.split("@")[0]?.trim() ?? "";
    return emailLocalPart || "OpenWork User";
  }, [user?.email, user?.name]);

  const userInitials = useMemo(() => {
    const parts = userDisplayName.split(/\s+/).filter(Boolean);
    return ((parts[0]?.slice(0, 1) ?? "O") + (parts[1]?.slice(0, 1) ?? "")).toUpperCase();
  }, [userDisplayName]);

  const activeOrg = useMemo(() => orgs.find((org) => org.isActive) ?? null, [orgs]);
  const showDirectCreateFlow = orgs.length === 0;
  const returningToSavedDraft = showDirectCreateFlow && hasPendingOrgDraft;
  const draftReadyAfterCheckout = returningToSavedDraft && Boolean(billingSummary?.hasActivePlan);

  useEffect(() => {
    if (!sessionHydrated) return;
    if (!user) {
      router.replace("/");
      return;
    }

    let isMounted = true;

    async function loadOrgs() {
      try {
        const { response, payload } = await requestJson("/v1/me/orgs", { method: "GET" });
        if (!response.ok) {
          throw new Error(getErrorMessage(payload, "Failed to load organizations."));
        }

        if (isMounted) {
          const parsed = parseOrgListPayload(payload);
          const nextOrgs = parsed.orgs.map((org) => ({ ...org, isActive: org.slug === parsed.activeOrgSlug }));
          setOrgs(nextOrgs);
          setShowCreate(nextOrgs.length === 0);
          setBusy(false);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "An error occurred.");
          setBusy(false);
        }
      }
    }

    void loadOrgs();

    return () => {
      isMounted = false;
    };
  }, [sessionHydrated, user, router]);

  useEffect(() => {
    if (!user?.email) {
      setHasPendingOrgDraft(false);
      return;
    }

    if (!showDirectCreateFlow) {
      clearPendingOrgDraft();
      setHasPendingOrgDraft(false);
      return;
    }

    const savedName = readPendingOrgDraft(user.email);
    if (!savedName) {
      setHasPendingOrgDraft(false);
      return;
    }

    setCreateName((current) => current || savedName);
    setHasPendingOrgDraft(true);
  }, [showDirectCreateFlow, user?.email]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = createName.trim();
    if (!trimmed) return;

    setCreateBusy(true);
    setCreateError(null);
    try {
      const { response, payload } = await requestJson("/v1/orgs", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });

      if (!response.ok) {
        if (response.status === 402) {
          writePendingOrgDraft(trimmed, user?.email);
          setHasPendingOrgDraft(true);
          setCreateBusy(false);
          router.push("/checkout");
          return;
        }
        throw new Error(getErrorMessage(payload, "Failed to create organization."));
      }

      const organization =
        typeof payload === "object" && payload && "organization" in payload && payload.organization && typeof payload.organization === "object"
          ? (payload.organization as { slug?: unknown })
          : null;
      const nextSlug = typeof organization?.slug === "string" ? organization.slug : null;

      if (!nextSlug) {
        throw new Error("Organization was created, but no slug was returned.");
      }

      clearPendingOrgDraft();
      setHasPendingOrgDraft(false);
      router.push(getOrgDashboardRoute(nextSlug));
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create organization.");
      setCreateBusy(false);
    }
  }

  function handleSwitch(slug: string) {
    router.push(getOrgDashboardRoute(slug));
  }

  if (!sessionHydrated || busy) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#fafafa]">
        <p className="text-sm text-gray-500">Loading organizations...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#fafafa]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-gray-900">OpenWork Cloud</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{user?.email}</span>
          <button
            onClick={() => void signOut()}
            className="text-gray-400 transition-colors hover:text-gray-900"
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 md:p-12">
        {showDirectCreateFlow ? (
          <div className="mx-auto max-w-2xl">
            <section className="rounded-[2rem] border border-gray-200 bg-white p-8 shadow-sm md:p-10">
              <div className="mb-8 flex items-start gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#011627] text-sm font-semibold uppercase tracking-[0.08em] text-white">
                  {userInitials}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium uppercase tracking-[0.18em] text-gray-400">OpenWork Cloud</p>
                  <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-gray-950">
                    {returningToSavedDraft ? "Finish creating your organization." : "Create your first organization."}
                  </h1>
                  <p className="mt-3 max-w-xl text-sm leading-6 text-gray-500">
                    {draftReadyAfterCheckout
                      ? "Your plan is ready. Confirm the workspace name below and create the workspace to finish setup."
                      : returningToSavedDraft
                        ? "We saved your workspace name so you can pick up right where you left off."
                        : "Name the workspace you want to set up for your team. If billing is enabled, the plan step comes right after this."}
                  </p>
                </div>
              </div>

              {error ? (
                <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
                  {error}
                </div>
              ) : null}

              <form onSubmit={handleCreate} className="grid gap-5">
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-gray-700">Organization name</span>
                  <input
                    type="text"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="Acme Corp"
                    className="w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-gray-400 focus:ring-4 focus:ring-gray-900/5"
                    autoFocus
                    required
                  />
                </label>

                {createError ? <p className="text-sm font-medium text-rose-600">{createError}</p> : null}

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={createBusy || !createName.trim()}
                    className="rounded-2xl bg-gray-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
                  >
                    {createBusy ? "Creating..." : returningToSavedDraft ? "Create organization" : "Continue"}
                  </button>
                  <p className="text-sm text-gray-500">Signed in as {user?.email ?? "your account"}</p>
                </div>
              </form>
            </section>
          </div>
        ) : (
          <div className="mx-auto max-w-5xl">
            <div className="mb-8">
              <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Settings</h1>
              <p className="mt-1 text-sm text-gray-500">Manage your profile and organization memberships.</p>
            </div>

            <div className="mb-8 flex gap-8 border-b border-gray-200">
              <button
                type="button"
                onClick={() => setActiveTab("profile")}
                className={`border-b-2 pb-3 text-sm font-medium transition-colors ${
                  activeTab === "profile"
                    ? "border-gray-900 text-gray-900"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Profile
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("organizations")}
                className={`border-b-2 pb-3 text-sm font-medium transition-colors ${
                  activeTab === "organizations"
                    ? "border-gray-900 text-gray-900"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Organizations
              </button>
            </div>

            {error ? (
              <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
                {error}
              </div>
            ) : null}

            {activeTab === "profile" ? (
              <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-6 flex items-start gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#011627] text-sm font-semibold uppercase tracking-[0.08em] text-white">
                    {userInitials}
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-medium text-gray-900">{userDisplayName}</h2>
                    <p className="mt-1 text-sm text-gray-500">{user?.email ?? "Signed in"}</p>
                  </div>
                </div>

                <div className="grid gap-5 md:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-gray-700">Full name</span>
                    <input
                      type="text"
                      value={user?.name ?? ""}
                      readOnly
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-none"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-gray-700">Email</span>
                    <input
                      type="email"
                      value={user?.email ?? ""}
                      readOnly
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-none"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-gray-700">User ID</span>
                    <input
                      type="text"
                      value={user?.id ?? ""}
                      readOnly
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-none"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-gray-700">Current organization</span>
                    <input
                      type="text"
                      value={activeOrg?.name ?? "No active organization"}
                      readOnly
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-none"
                    />
                  </label>
                </div>
              </section>
            ) : (
              <>
                <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-2xl text-sm text-gray-500">
                    Organizations are independent environments. In each organization you can collaborate with other members and manage your own resources.
                  </p>
                  <button
                    onClick={() => setShowCreate(true)}
                    className="shrink-0 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                  >
                    + Create New Organization
                  </button>
                </div>

                {showCreate ? (
                  <div className="mb-8 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="mb-4 text-lg font-medium text-gray-900">Create an Organization</h2>
                    <form onSubmit={handleCreate} className="grid max-w-md gap-4">
                      <label className="grid gap-2">
                        <span className="text-sm font-medium text-gray-700">Organization Name</span>
                        <input
                          type="text"
                          value={createName}
                          onChange={(e) => setCreateName(e.target.value)}
                          placeholder="Acme Corp"
                          className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-900 outline-none transition focus:border-gray-400 focus:ring-4 focus:ring-gray-900/5"
                          autoFocus
                          required
                        />
                      </label>

                      <div className="flex gap-3 pt-2">
                        <button
                          type="button"
                          onClick={() => {
                            setShowCreate(false);
                            setCreateName("");
                            setCreateError(null);
                          }}
                          className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={createBusy || !createName.trim()}
                          className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
                        >
                          {createBusy ? "Creating..." : "Create"}
                        </button>
                      </div>

                      {createError ? <p className="text-sm font-medium text-rose-600">{createError}</p> : null}
                    </form>
                  </div>
                ) : null}

                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b border-gray-200 bg-gray-50/50">
                        <tr>
                          <th className="px-6 py-4 font-medium text-gray-500">Organization</th>
                          <th className="px-6 py-4 font-medium text-gray-500">Seat Type</th>
                          <th className="px-6 py-4 text-right font-medium text-gray-500">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {orgs.map((org) => (
                          <tr key={org.id} className="transition-colors hover:bg-gray-50/50">
                            <td className="px-6 py-4">
                              <div className="font-medium text-gray-900">{org.name}</div>
                              <div className="mt-1 text-xs text-gray-500">
                                {org.role === "owner" ? "Creator plan" : "Free plan"} • 1 member
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-gray-700">{formatRoleLabel(org.role)}</span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              {org.isActive ? (
                                <span className="inline-flex cursor-default items-center rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-500">
                                  Current Organization
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleSwitch(org.slug)}
                                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition hover:bg-gray-50"
                                >
                                  Switch
                                </button>
                              )}
                              <button
                                onClick={() => handleSwitch(org.slug)}
                                className="ml-2 inline-flex items-center justify-center rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                                aria-label="Organization settings"
                              >
                                <Settings className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <p className="mt-8 text-center text-sm text-gray-500">You have no pending organization invites.</p>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
