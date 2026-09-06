"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LogOut, Settings } from "lucide-react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";
import { type DenOrgSummary, formatRoleLabel, getJoinOrgRoute, getOnboardingToolsRoute, getOrgDashboardRoute, parseOrgListPayload } from "../_lib/den-org";
import { useOrgListWindow } from "../_lib/use-org-list-window";
import { useDenFlow } from "../_providers/den-flow-provider";

import { DesktopSetupChoices, WorkspaceIntentChoices, type DesktopSetup, type WorkspaceIntent } from "./workspace-intent";
import { applyRestrictedSetup } from "../_lib/restricted-setup";
import { SetupFrame } from "./setup-frame";

type SettingsTab = "profile" | "organizations";

export function OrganizationScreen() {
  const router = useRouter();
  const { user, sessionHydrated, signOut, runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const [orgs, setOrgs] = useState<DenOrgSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("organizations");
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [intent, setIntent] = useState<WorkspaceIntent | null>(null);
  const [desktopSetup, setDesktopSetup] = useState<DesktopSetup | null>(null);
  const [invitationLink, setInvitationLink] = useState("");
  const [createdOrg, setCreatedOrg] = useState<{ id: string; slug: string } | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
  const isSingleOrgMode = runtimeConfigLoaded && runtimeConfig.orgMode === "single_org";
  const singleOrgName = runtimeConfig.singleOrgName || "OpenWork";
  const singleOrgSlug = runtimeConfig.singleOrgSlug.trim();
  const showDirectCreateFlow = !isSingleOrgMode && orgs.length === 0;
  const {
    query: orgQuery,
    setQuery: setOrgQuery,
    visible: visibleOrgs,
    filteredCount: orgFilteredCount,
    hasMore: orgHasMore,
    showMore: showMoreOrgs,
    showSearch: showOrgSearch,
  } = useOrgListWindow(orgs);

  useEffect(() => {
    if (!sessionHydrated || !runtimeConfigLoaded) return;
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
          const targetOrg = nextOrgs.find((org) => org.isActive) ?? nextOrgs[0] ?? null;
          if (isSingleOrgMode && targetOrg) {
            router.replace(getOrgDashboardRoute(targetOrg.slug));
            return;
          }
          setOrgs(nextOrgs);
          setShowCreate(!isSingleOrgMode && nextOrgs.length === 0);
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
  }, [isSingleOrgMode, runtimeConfigLoaded, sessionHydrated, user, router]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (isSingleOrgMode) {
      setCreateError("This deployment uses one managed organization.");
      return;
    }

    if (intent === "join") {
      try {
        const url = new URL(invitationLink.trim(), window.location.origin);
        const invitationId = url.searchParams.get("invite")?.trim();
        if (url.origin !== window.location.origin || url.pathname !== "/join-org" || !invitationId) {
          throw new Error("Paste the invitation link for this OpenWork Cloud. Ask your team owner if you do not have one yet.");
        }
        router.push(getJoinOrgRoute(invitationId));
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : "Enter a valid invitation link.");
      }
      return;
    }
    const trimmed = createName.trim();
    if (!intent || trimmed.length < 2 || (intent === "team" && !desktopSetup)) return;

    setCreateBusy(true);
    setCreateError(null);
    try {
      let nextOrg = createdOrg;
      if (!nextOrg) {
        const { response, payload } = await requestJson("/v1/org", {
          method: "POST",
          body: JSON.stringify({ name: trimmed }),
        });

        if (!response.ok) {
          throw new Error(getErrorMessage(payload, "Failed to create organization."));
        }

        const organization =
          typeof payload === "object" && payload && "organization" in payload && payload.organization && typeof payload.organization === "object"
            ? payload.organization
            : null;
        if (!organization || !("slug" in organization) || typeof organization.slug !== "string" || !organization.slug || !("id" in organization) || typeof organization.id !== "string") {
          throw new Error("Organization was created, but no slug was returned.");
        }

        nextOrg = { id: organization.id, slug: organization.slug };
        setCreatedOrg(nextOrg);
      }
      if (intent === "team" && desktopSetup === "restricted") {
        await applyRestrictedSetup(nextOrg.id);
      }
      router.push(getOnboardingToolsRoute(nextOrg.slug));
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create organization.");
      setCreateBusy(false);
    }
  }

  const creationForm = <form onSubmit={handleCreate} className="grid gap-5" aria-busy={createBusy}>
    <WorkspaceIntentChoices intent={intent} disabled={createBusy || Boolean(createdOrg)} onChange={(next) => { setIntent(next); setCreateError(null); }} />
    {intent === "join" ? <label className="grid gap-2">
      <span className="text-sm font-medium text-gray-700">Team invitation link</span>
      <input type="text" value={invitationLink} onChange={(event) => setInvitationLink(event.target.value)} placeholder="Paste your invitation link" required className="rounded-xl border border-gray-200 px-4 py-3 text-sm focus:ring-2 focus:ring-gray-900" />
      <span className="text-xs leading-5 text-gray-500">You will review the team and invited email before accepting. This does not create another organization.</span>
    </label> : intent ? <>
      <label className="grid gap-2">
        <span className="text-sm font-medium text-gray-700">{intent === "personal" ? "Organization name" : "Team name"}</span>
        <input type="text" value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder={intent === "personal" ? "My work" : "Design team"} minLength={2} maxLength={120} disabled={createBusy || Boolean(createdOrg)} required className="rounded-xl border border-gray-200 px-4 py-3 text-sm focus:ring-2 focus:ring-gray-900" />
      </label>
      {intent === "team" ? <DesktopSetupChoices mode={desktopSetup} onChange={setDesktopSetup} disabled={createBusy || Boolean(createdOrg)} /> : <p className="text-sm leading-6 text-gray-500">Start with your own tools. Creating this organization does not upload the files in your desktop workspaces.</p>}
    </> : null}
    {createError ? <p role="alert" className="text-sm text-rose-600">{createError}</p> : null}
    {createdOrg && createError && desktopSetup === "restricted" ? <button type="button" onClick={() => { setDesktopSetup("flexible"); setCreateError(null); }} className="justify-self-start text-sm text-neutral-500 underline underline-offset-4 hover:text-neutral-900">Use Flexible instead</button> : null}
    {createdOrg && intent === "team" && desktopSetup === "restricted" ? <p role="status" className="text-sm text-gray-600">Your team is saved. We’ll finish applying its settings before continuing.</p> : null}
    <button type="submit" disabled={createBusy || !intent || (intent === "join" ? !invitationLink.trim() : createName.trim().length < 2 || (intent === "team" && !desktopSetup))} className="w-full rounded-xl bg-gray-950 px-5 py-3.5 text-sm font-medium text-white hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-gray-600 focus-visible:ring-offset-2 disabled:opacity-50">
      {createBusy ? "Setting up…" : createdOrg && desktopSetup === "restricted" ? "Retry setup" : intent === "join" ? "Review invitation" : "Continue"}
    </button>
  </form>;

  function handleSwitch(slug: string) {
    router.push(getOrgDashboardRoute(slug));
  }

  if (!sessionHydrated || !runtimeConfigLoaded || busy) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#fafafa]">
        <p className="text-sm text-gray-500">Loading organizations...</p>
      </div>
    );
  }

  if (!isSingleOrgMode && (showDirectCreateFlow || showCreate)) {
    return <SetupFrame step="space" title="Make it yours." description="A space for your tools, your team, and whatever comes next.">
      <div className="mb-6">
        <h2 className="text-[23px] font-semibold tracking-[-.035em]">A little about your work.</h2>
        <p className="mt-2 text-[13px] leading-6 text-gray-500">Choose a starting point. You can invite people in the next step.</p>
      </div>
      {error ? <p role="alert" className="mb-4 text-sm text-rose-600">{error}</p> : null}
      {creationForm}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-5 text-xs text-gray-500">
        <span className="max-w-[260px] truncate">{user?.email}</span>
        {!createBusy && !createdOrg && orgs.length > 0 ? <button type="button" className="font-medium text-gray-700" onClick={() => { setShowCreate(false); setCreateName(""); setIntent(null); setDesktopSetup(null); setCreateError(null); }}>Cancel</button> : <button type="button" disabled={createBusy} onClick={() => void signOut()} className="font-medium text-gray-700">Log out</button>}
      </div>
    </SetupFrame>;
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#fafafa]">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-gray-900">OpenWork Cloud</span>
        </div>
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <span className="min-w-0 truncate text-sm text-gray-500">{user?.email}</span>
          <button
            onClick={() => void signOut()}
            className="text-gray-400 transition-colors hover:text-gray-900"
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-12">
        {isSingleOrgMode && orgs.length === 0 ? (
          <div className="mx-auto max-w-2xl">
            <section className="rounded-[1.75rem] border border-gray-200 bg-white p-5 shadow-xs sm:p-7 md:rounded-[2rem] md:p-10">
              <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#011627] text-sm font-semibold uppercase tracking-[0.08em] text-white sm:h-14 sm:w-14">
                  {userInitials}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium uppercase tracking-[0.18em] text-gray-400">OpenWork</p>
                  <h1 className="mt-2 text-[2rem] font-semibold leading-none tracking-[-0.04em] text-gray-950 sm:text-3xl">
                    {singleOrgName}
                  </h1>
                  <p className="mt-3 max-w-xl text-[13px] leading-6 text-gray-500 sm:text-sm">
                    This deployment uses one managed organization. Once setup is complete, you will be taken straight to the workspace.
                  </p>
                </div>
              </div>

              {error ? (
                <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
                  {error}
                </div>
              ) : null}

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                {singleOrgSlug ? (
                  <button
                    type="button"
                    className="w-full rounded-2xl bg-gray-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800 sm:w-auto"
                    onClick={() => router.push(`/sso/${encodeURIComponent(singleOrgSlug)}`)}
                  >
                    Continue with SSO
                  </button>
                ) : null}
                <button
                  type="button"
                  className="w-full rounded-2xl border border-gray-200 px-5 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:w-auto"
                  onClick={() => window.location.reload()}
                >
                  Check again
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {!isSingleOrgMode ? (
          <div className="mx-auto max-w-5xl">
            <div className="mb-6 sm:mb-8">
              <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Settings</h1>
              <p className="mt-1 text-sm text-gray-500">Manage your profile and organization memberships.</p>
            </div>

            <div className="mb-6 flex gap-6 overflow-x-auto border-b border-gray-200 sm:mb-8 sm:gap-8">
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
              <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-xs">
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
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-hidden"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-gray-700">Email</span>
                    <input
                      type="email"
                      value={user?.email ?? ""}
                      readOnly
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-hidden"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-gray-700">User ID</span>
                    <input
                      type="text"
                      value={user?.id ?? ""}
                      readOnly
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-hidden"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-gray-700">Current organization</span>
                    <input
                      type="text"
                      value={activeOrg?.name ?? "No active organization"}
                      readOnly
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 outline-hidden"
                    />
                  </label>
                </div>
              </section>
            ) : (
              <>
                <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <p className="max-w-2xl text-sm text-gray-500">
                    Organizations are independent environments. In each organization you can collaborate with other members and manage your own resources.
                  </p>
                  <div className="flex w-full flex-col gap-3 sm:w-auto sm:min-w-[18rem]">
                    {showOrgSearch ? (
                      <input
                        type="search"
                        value={orgQuery}
                        onChange={(event) => setOrgQuery(event.target.value)}
                        placeholder="Search organizations"
                        className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-900 outline-hidden transition focus:border-gray-400 focus:ring-4 focus:ring-gray-900/5"
                      />
                    ) : null}
                    <button
                      onClick={() => setShowCreate(true)}
                      className="w-full shrink-0 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 sm:w-auto"
                    >
                      + Create New Organization
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 md:hidden">
                  {visibleOrgs.map((org) => (
                    <section key={org.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-xs">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="truncate text-[15px] font-semibold text-gray-950">{org.name}</h2>
                          <p className="mt-1 text-xs text-gray-500">
                            {org.role === "owner" ? "Creator plan" : "Free plan"} • {formatRoleLabel(org.role)}
                          </p>
                        </div>
                        {org.isActive ? (
                          <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                            Current
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button
                          onClick={() => handleSwitch(org.slug)}
                          className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 shadow-xs transition hover:bg-gray-50"
                        >
                          {org.isActive ? "Open" : "Switch"}
                        </button>
                        <button
                          onClick={() => handleSwitch(org.slug)}
                          className="inline-flex items-center justify-center rounded-xl border border-gray-200 px-3 py-2.5 text-gray-500 transition hover:bg-gray-50 hover:text-gray-800"
                          aria-label="Organization settings"
                        >
                          <Settings className="h-4 w-4" />
                        </button>
                      </div>
                    </section>
                  ))}
                </div>

                <div className="hidden overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xs md:block">
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
                        {visibleOrgs.map((org) => (
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
                                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-xs transition hover:bg-gray-50"
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

                {orgFilteredCount === 0 && orgQuery ? (
                  <p className="mt-4 text-sm text-gray-500">No organizations match your search.</p>
                ) : null}

                {orgHasMore ? (
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-gray-500">
                      Showing {visibleOrgs.length} of {orgFilteredCount} organizations
                    </p>
                    <button
                      type="button"
                      onClick={showMoreOrgs}
                      className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-xs transition hover:bg-gray-50 sm:w-auto"
                    >
                      Show more
                    </button>
                  </div>
                ) : null}

                <p className="mt-8 text-center text-sm text-gray-500">You have no pending organization invites.</p>
              </>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
